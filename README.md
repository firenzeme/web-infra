# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Deployment

### Prerequisites
1. Ensure the `github-token` secret exists in AWS Secrets Manager (Plaintext PAT).
2. Configure AWS credentials (`aws configure`).

### Deploying the Production Environment
```bash
npx cdk deploy -c env=prod
```
This will:
- Use SSM parameters from `/firenze/prod/*`
- Create `prod.firenzegroup.co` (Webapp)
- Create `prod-api.firenzegroup.co` (API)

### Deploying Additional Environments (e.g., Staging)
```bash
npx cdk deploy -c env=staging
```
This will:
- Use SSM parameters from `/firenze/staging/*`
- Create `staging.firenzegroup.co` (Webapp)
- Create `staging-api.firenzegroup.co` (API)
