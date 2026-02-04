import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Lambda code for Pre Token Generation V2 trigger
 *
 * Adds custom claims to both access and ID tokens:
 * - domainId: from user's custom:domainId attribute (for multi-tenant isolation)
 */
const PRE_TOKEN_GENERATION_CODE = `
exports.handler = async (event) => {
  console.log('Pre Token Generation Event:', JSON.stringify(event, null, 2));

  // Get the domainId from user attributes, default to null if not present
  const domainId = event.request.userAttributes['custom:domainId'] || null;

  // V3 Trigger - supports both user and machine identities
  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          domainId: domainId,
        },
      },
      idTokenGeneration: {
        claimsToAddOrOverride: {
          domainId: domainId,
        },
      },
    },
  };

  console.log('Added domainId claim:', domainId);
  console.log('Response:', JSON.stringify(event.response, null, 2));

  return event;
};
`;

/**
 * Cognito Lambda Stack
 *
 * Creates Lambda functions for Cognito triggers that are shared across environments.
 * These Lambdas are attached to user pools manually or via separate automation.
 *
 * Triggers included:
 * - Pre Token Generation V2 (V3_0): Adds custom claims (domainId) to tokens
 */
export class CognitoLambdaStack extends cdk.Stack {
  public readonly preTokenGenerationLambda: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // IAM Role for Lambda
    const lambdaRole = new iam.Role(this, 'PreTokenGenerationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Pre Token Generation Lambda (V2/V3_0 trigger)
    // Using inline code to avoid Docker dependency for bundling
    this.preTokenGenerationLambda = new lambda.Function(this, 'PreTokenGenerationLambda', {
      functionName: 'cognito-pre-token-generation',
      code: lambda.Code.fromInline(PRE_TOKEN_GENERATION_CODE),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      role: lambdaRole,
      description: 'Cognito Pre Token Generation V2 trigger - adds domainId claim to tokens',
    });

    // Grant Cognito permission to invoke the Lambda
    this.preTokenGenerationLambda.addPermission('CognitoInvoke', {
      principal: new iam.ServicePrincipal('cognito-idp.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/*`,
    });

    // Output the Lambda ARN for manual attachment to user pools
    new cdk.CfnOutput(this, 'PreTokenGenerationLambdaArn', {
      value: this.preTokenGenerationLambda.functionArn,
      description: 'ARN of the Pre Token Generation Lambda to attach to Cognito user pools',
      exportName: 'CognitoPreTokenGenerationLambdaArn',
    });
  }
}
