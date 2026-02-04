#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { WebInfraStack } from '../lib/web-infra-stack';
import { CognitoLambdaStack } from '../lib/cognito-lambda-stack';

const app = new cdk.App();

const envName = app.node.tryGetContext('env') || 'prod';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Environment-specific web infrastructure (EC2, Amplify, ALB, etc.)
new WebInfraStack(app, `WebInfraStack-${envName}`, {
  envName,
  env,
});

// Shared Cognito Lambda functions (environment-agnostic)
// Deploy once per account, attach to user pools manually or via automation
new CognitoLambdaStack(app, 'CognitoLambdaStack', {
  env,
  description: 'Cognito Lambda triggers for pre-token generation',
});
