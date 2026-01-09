import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

interface WebInfraStackProps extends cdk.StackProps {
  envName: string;
}

export class WebInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebInfraStackProps) {
    super(scope, id, props);

    const { envName } = props;

    // 1. VPC & Networking
    const vpc = new ec2.Vpc(this, `FirenzeVpc-${envName}`, {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
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

    // Add UserData for EC2
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'yum update -y',
      'curl -sL https://rpm.nodesource.com/setup_20.x | bash -',
      'yum install -y nodejs git jq',
      'npm install -g pnpm pm2',
      'mkdir -p /var/www/firenze-api',

      // Create deployment script
      'cat << "EOF" > /usr/local/bin/deploy-api',
      '#!/bin/bash',
      'set -e',
      'exec > >(tee /var/log/deploy-api.log) 2>&1',
      'echo "Starting deployment at $(date)"',
      '',
      // export HOME to ensure global npm packages found if needed, though they are in /usr/bin usually
      'export HOME=/root',
      '',
      'TOKEN=$(aws secretsmanager get-secret-value --secret-id github-token --query SecretString --output text --region ' + this.region + ')',
      'REPO_URL="https://${TOKEN}@github.com/firenzeme/web-api.git"',
      'TARGET_DIR="/var/www/firenze-api"',
      '',
      'if [ ! -d "$TARGET_DIR/.git" ]; then',
      '  echo "Cloning repository..."',
      '  git clone "$REPO_URL" "$TARGET_DIR"',
      'else',
      '  echo "Pulling latest changes..."',
      '  cd "$TARGET_DIR"',
      '  # Update remote url with token in case it changed',
      '  git remote set-url origin "$REPO_URL"',
      '  git pull origin main',
      'fi',
      '',
      'cd "$TARGET_DIR"',
      'chmod +x scripts/deploy-ec2.sh',
      '',
      // Set ENVIRONMENT based on stack envName. 
      // Mapping: prod -> production, everything else -> as is (staging, dev)
      `export ENVIRONMENT=${envName === 'prod' ? 'production' : envName}`,
      'export AWS_REGION=' + this.region,
      '',
      './scripts/deploy-ec2.sh',
      'EOF',
      '',
      'chmod +x /usr/local/bin/deploy-api',
      // Run it immediately on first boot
      '/usr/local/bin/deploy-api'
    );

    const apiInstance = new ec2.Instance(this, `WebApiInstance-${envName}`, {
      vpc,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: apiRole,
      securityGroup: apiSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      userData,
    });

    // 4. Amplify App for webapp
    const amplifyApp = new amplify.CfnApp(this, `FirenzeWebapp-${envName}`, {
      name: `firenze-webapp-${envName}`,
      repository: 'https://github.com/firenzeme/webapp',
      accessToken: cdk.SecretValue.secretsManager('github-token').unsafeUnwrap(),
      iamServiceRole: new iam.Role(this, `AmplifyRole-${envName}`, {
        assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify'),
        ],
      }).roleArn,
      environmentVariables: [
        { name: 'NODE_ENV', value: envName === 'prod' ? 'production' : envName },
        { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'webapp' },
        { name: 'NODE_VERSION', value: '20' },
      ],
      customRules: [
        {
          source: '/<*>',
          target: '/index.html',
          status: '200',
        },
      ],
    });

    const amplifyBranch = new amplify.CfnBranch(this, `MainBranch-${envName}`, {
      appId: amplifyApp.attrAppId,
      branchName: 'main',
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

    // API DNS Record
    new route53.ARecord(this, `ApiAliasRecord-${envName}`, {
      zone,
      recordName: `${envName}-api.${domainName}`,
      target: route53.RecordTarget.fromIpAddresses(apiInstance.instancePublicIp),
    });
  }
}
