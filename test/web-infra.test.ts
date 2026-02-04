import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CognitoLambdaStack } from '../lib/cognito-lambda-stack';

describe('CognitoLambdaStack', () => {
  test('creates Pre Token Generation Lambda', () => {
    const app = new cdk.App();
    const stack = new CognitoLambdaStack(app, 'TestCognitoLambdaStack');
    const template = Template.fromStack(stack);

    // Verify Lambda function is created
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'cognito-pre-token-generation',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      Architectures: ['arm64'],
    });
  });

  test('Lambda has Cognito invoke permission', () => {
    const app = new cdk.App();
    const stack = new CognitoLambdaStack(app, 'TestCognitoLambdaStack');
    const template = Template.fromStack(stack);

    // Verify Lambda permission for Cognito
    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'cognito-idp.amazonaws.com',
    });
  });

  test('Lambda has basic execution role', () => {
    const app = new cdk.App();
    const stack = new CognitoLambdaStack(app, 'TestCognitoLambdaStack');
    const template = Template.fromStack(stack);

    // Verify IAM role with Lambda basic execution policy
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              Service: 'lambda.amazonaws.com',
            },
          },
        ],
      },
    });
  });

  test('exports Lambda ARN', () => {
    const app = new cdk.App();
    const stack = new CognitoLambdaStack(app, 'TestCognitoLambdaStack');
    const template = Template.fromStack(stack);

    // Verify output is exported
    template.hasOutput('PreTokenGenerationLambdaArn', {
      Export: {
        Name: 'CognitoPreTokenGenerationLambdaArn',
      },
    });
  });
});
