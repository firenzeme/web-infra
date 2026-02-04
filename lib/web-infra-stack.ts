import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2_targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';

interface WebInfraStackProps extends cdk.StackProps {
  envName: string;
}

export class WebInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebInfraStackProps) {
    super(scope, id, props);

    const { envName } = props;

    const envConfig = {
      prod: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
        apiCertificateArn: 'arn:aws:acm:eu-west-2:970547365389:certificate/03201aca-2a46-43f2-bc4d-ffdc09bfa3ef',
      },
      dev: {
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
        apiCertificateArn: 'arn:aws:acm:eu-west-2:970547365389:certificate/72b645e1-3813-41bd-bbe3-f6a2d6d04d4b',
      },
    }[envName as 'prod' | 'dev'] || {
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      apiCertificateArn: undefined,
    };

    // 1. VPC & Networking - Import existing VPC where ALB lives
    const vpc = ec2.Vpc.fromLookup(this, `FirenzeVpc-${envName}`, {
      vpcId: 'vpc-0b3948289cdc1f69a',
    });

    // 2. IAM Role for EC2 (web-api)
    const apiRole = new iam.Role(this, `WebApiRole-${envName}`, {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Add SSM permissions for envilder - dynamic based on envName
    apiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/firenze/${envName}/api/*`,
      ],
    }));

    // Grant access to GitHub token for git operations
    apiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['secretsmanager:GetSecretValue'],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:github-token-*`,
      ],
    }));

    // 3. EC2 Instance for web-api
    const apiSecurityGroup = new ec2.SecurityGroup(this, `WebApiSG-${envName}`, {
      vpc,
      allowAllOutbound: true,
      description: `Security group for Firenze Web API (${envName})`,
    });

    apiSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
    apiSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');
    apiSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3001), 'Allow API Port');
    apiSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'Allow SSH');

    // Add UserData for EC2
    const userData = ec2.UserData.forLinux();
    // Create the deployment script
    // This script is the "Coordinator" that running on the instance.
    // It runs as root (initially) but switches to ec2-user for all application logic.
    userData.addCommands(
      // Setup swap space (2GB)
      'dd if=/dev/zero of=/swapfile bs=128M count=16',
      'chmod 600 /swapfile',
      'mkswap /swapfile',
      'swapon /swapfile',
      'echo "/swapfile swap swap defaults 0 0" >> /etc/fstab',

      'yum update -y',
      'curl -sL https://rpm.nodesource.com/setup_20.x | bash -',
      'yum install -y nodejs git jq',
      'npm install -g pnpm pm2',

      // Create the script
      // The script accepts a branch argument (defaults based on environment)
      // Usage: /usr/local/bin/deploy-api [branch]
      'cat << "EOF" > /usr/local/bin/deploy-api',
      '#!/bin/bash',
      'set -e',
      'exec > >(tee /var/log/deploy-api.log) 2>&1',

      '# Configuration',
      'APP_DIR="/home/ec2-user/firenze-api"',
      'DEFAULT_BRANCH=' + (envName === 'prod' ? 'main' : 'dev'),
      'BRANCH="${1:-$DEFAULT_BRANCH}"',
      'export AWS_REGION=' + this.region,

      'echo "Deploy script called with branch: $BRANCH (default: $DEFAULT_BRANCH)"',

      '# Ensure directory exists and permissions are correct',
      'mkdir -p "$APP_DIR"',
      'chown ec2-user:ec2-user "$APP_DIR"',

      '# Run the actual deployment logic as ec2-user',
      'su - ec2-user -c "set -e',
      '  BRANCH=\"$BRANCH\"',
      '  export ENVIRONMENT=' + (envName === 'prod' ? 'production' : envName),
      '  export HOME=/home/ec2-user',
      '  export AWS_REGION=' + this.region,

      '  # Fetch Token (running as ec2-user, leveraging Instance Profile)',
      '  TOKEN=\\$(aws secretsmanager get-secret-value --secret-id github-token --query SecretString --output text --region ' + this.region + ')',

      '  REPO_URL=\\"https://\\${TOKEN}@github.com/firenzeme/web-api.git\\"',
      '  TARGET_DIR=\\"/home/ec2-user/firenze-api\\"',

      '  echo \\"Deploying branch \\$BRANCH to \\$TARGET_DIR in environment \\$ENVIRONMENT\\"',

      '  if [ ! -d \\"\\$TARGET_DIR/.git\\" ]; then',
      '    echo \\"Cloning repository (branch: \\$BRANCH)...\\"',
      '    git clone -b \\"\\$BRANCH\\" \\"\\$REPO_URL\\" \\"\\$TARGET_DIR\\"',
      '  else',
      '    echo \\"Fetching and resetting to origin/\\$BRANCH...\\"',
      '    cd \\"\\$TARGET_DIR\\"',
      '    git remote set-url origin \\"\\$REPO_URL\\"',
      '    git fetch origin \\"\\$BRANCH\\"',
      '    git reset --hard \\"origin/\\$BRANCH\\"',
      '  fi',

      '  cd \\"\\$TARGET_DIR\\"',
      '  chmod +x scripts/deploy-ec2.sh',

      '  # Run the repo-provided build script',
      '  ./scripts/deploy-ec2.sh',

      '  # Ensure persistence',
      '  pm2 save',
      '"',

      '# Ensure PM2 starts on boot (running as root to register systemd, but for ec2-user)',
      'pm2 startup systemd -u ec2-user --hp /home/ec2-user',
      'pm2 save',
      'EOF',

      'chmod +x /usr/local/bin/deploy-api',

      // Run it immediately on first boot to bootstrap the app (uses default branch for environment)
      '/usr/local/bin/deploy-api'
    );

    // We rename to V4 to force replacement of the broken dev instance (since we lack Terminate permissions)
    const apiInstance = new ec2.Instance(this, `WebApiInstanceV4-${envName}`, {
      vpc,
      instanceName: `WebApiInstance-${envName}`, // Explicit name to make it easier to find in CI/CD
      instanceType: envConfig.instanceType,
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: apiRole,
      securityGroup: apiSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      keyName: 'firenze-api-key',
      userData,
    });

    // Elastic IP for stable SSH access
    const eip = new ec2.CfnEIP(this, `WebApiEIP-${envName}`, {
      domain: 'vpc',
      tags: [{ key: 'Name', value: `WebApiEIP-${envName}` }],
    });

    new ec2.CfnEIPAssociation(this, `WebApiEIPAssoc-${envName}`, {
      eip: eip.ref,
      instanceId: apiInstance.instanceId,
    });

    // Output the Elastic IP for SSH config
    new cdk.CfnOutput(this, `WebApiElasticIP-${envName}`, {
      value: eip.ref,
      description: `Elastic IP for WebApiInstance-${envName}`,
    });

    // 4. ALB Integration - Create target group and listener rule
    // ALB details for reference:
    const albArn = 'arn:aws:elasticloadbalancing:eu-west-2:970547365389:loadbalancer/app/firenze-webapi-lb/2247a915d05f217e';
    const albDnsName = 'firenze-webapi-lb-1903631309.eu-west-2.elb.amazonaws.com';

    // Create target group for this environment
    const targetGroup = new elbv2.ApplicationTargetGroup(this, `ApiTargetGroup-${envName}`, {
      vpc,
      targetGroupName: `webapi-${envName}`,
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        path: '/health',
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
      },
      targets: [new elbv2_targets.InstanceTarget(apiInstance, 3001)],
    });

    // 3. ALB Support (Listener Certificate)
    if (envConfig.apiCertificateArn) {
      new elbv2.ApplicationListenerCertificate(this, `ApiCertAssociation-${envName}`, {
        listener: elbv2.ApplicationListener.fromLookup(this, 'SharedHttpsListener', {
          loadBalancerArn: 'arn:aws:elasticloadbalancing:eu-west-2:970547365389:loadbalancer/app/firenze-webapi-lb/2247a915d05f217e',
          listenerPort: 443,
        }),
        certificates: [elbv2.ListenerCertificate.fromArn(envConfig.apiCertificateArn)],
      });
    }

    // Add listener rule using CfnListenerRule (low-level construct to avoid lookup)
    const httpsListenerArn = 'arn:aws:elasticloadbalancing:eu-west-2:970547365389:listener/app/firenze-webapi-lb/2247a915d05f217e/4d18e5818f2b8930';

    new elbv2.CfnListenerRule(this, `ApiListenerRule-${envName}`, {
      listenerArn: httpsListenerArn,
      priority: envName === 'prod' ? 10 : 20,
      conditions: [
        {
          field: 'host-header',
          hostHeaderConfig: {
            values: [`api.${envName}.firenzegroup.co`],
          },
        },
      ],
      actions: [
        {
          type: 'forward',
          targetGroupArn: targetGroup.targetGroupArn,
        },
      ],
    });

    // 4. Amplify App for webapp
    const amplifyRole = new iam.Role(this, `AmplifyRole-${envName}`, {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify'),
      ],
    });

    // Grant SSM permissions for Envilder
    amplifyRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/firenze/${envName}/webapp/*`,
        // We also need access to shared params if any
        `arn:aws:ssm:${this.region}:${this.account}:parameter/firenze/${envName}/api/*`,
      ],
    }));

    const amplifyApp = new amplify.CfnApp(this, `FirenzeWebapp-${envName}`, {
      name: `firenze-webapp-${envName}`,
      repository: 'https://github.com/firenzeme/webapp',
      accessToken: cdk.SecretValue.secretsManager('github-token').unsafeUnwrap(),
      iamServiceRole: amplifyRole.roleArn,
      // Basic Auth: prod/firenze for prod, dev/firenze for dev
      basicAuthConfig: {
        enableBasicAuth: true,
        username: envName,
        password: 'firenze',
      },
      environmentVariables: [
        { name: 'NODE_ENV', value: envName === 'prod' ? 'production' : envName },
        { name: 'NODE_VERSION', value: '20' },
        { name: 'ENVILDER_MAP', value: envName === 'prod' ? 'envilder.prod.json' : 'envilder.dev.json' },
        { name: 'ENVFILE', value: '.env' },
        { name: 'AMPLIFY_SKIP_APP_ID_MISMATCH_CHECK', value: 'true' },
      ],
      customRules: [
        // Static assets - must come BEFORE the SPA fallback
        { source: '/assets/<*>', target: '/assets/<*>', status: '200' },
        { source: '/images/<*>', target: '/images/<*>', status: '200' },
        { source: '/videos/<*>', target: '/videos/<*>', status: '200' },
        { source: '/.well-known/<*>', target: '/.well-known/<*>', status: '200' },
        { source: '/cognito-config.json', target: '/cognito-config.json', status: '200' },
        { source: '/favicon.ico', target: '/favicon.ico', status: '200' },
        { source: '/robots.txt', target: '/robots.txt', status: '200' },
        // SPA fallback - catch-all must be last
        { source: '/<*>', target: '/index.html', status: '200' },
      ],
    });

    const amplifyBranch = new amplify.CfnBranch(this, `MainBranch-${envName}`, {
      appId: amplifyApp.attrAppId,
      branchName: envName === 'prod' ? 'main' : 'dev',
      enableAutoBuild: true,
    });

    // 5. DNS / Route53
    const domainName = 'firenzegroup.co';
    const zone = route53.HostedZone.fromLookup(this, `Zone-${envName}`, { domainName });

    // Webapp Domain Association
    const amplifyDomain = new amplify.CfnDomain(this, `AmplifyDomain-${envName}`, {
      appId: amplifyApp.attrAppId,
      domainName: `${envName}.${domainName}`,
      subDomainSettings: [
        {
          branchName: amplifyBranch.branchName,
          prefix: '', // This makes it {envName}.firenzegroup.co
        },
      ],
    });
    amplifyDomain.addDependency(amplifyBranch);

    // API DNS Record - CNAME pointing to ALB
    new route53.CnameRecord(this, `ApiCnameRecord-${envName}`, {
      zone,
      recordName: `api.${envName}`, // Creates api.prod.firenzegroup.co or api.dev.firenzegroup.co
      domainName: albDnsName,
    });
  }
}
