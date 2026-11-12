import { fileURLToPath } from 'node:url'
import { ArnFormat, type Stack } from 'aws-cdk-lib'
import { CfnRuntime } from 'aws-cdk-lib/aws-bedrockagentcore'
import { PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import type { IFunction } from 'aws-cdk-lib/aws-lambda'
import { Asset } from 'aws-cdk-lib/aws-s3-assets'

const modelId = 'anthropic.claude-haiku-4-5-20251001-v1:0'
const inferenceProfileId = `us.${modelId}`
// Destinos do perfil US do Haiku 4.5 para requisições originadas em us-east-1.
const inferenceRegions = ['us-east-1', 'us-east-2', 'us-west-2']

export function addAgentRuntime(stack: Stack, paymentTools: IFunction) {
  const name = `${stack.stackName.replaceAll('-', '_')}_agent`
  const artifact = new Asset(stack, 'AgentCode', {
    path: fileURLToPath(new URL('../agent/dist/agent.zip', import.meta.url)),
  })
  const runtimeArnPattern = stack.formatArn({
    service: 'bedrock-agentcore',
    resource: 'runtime',
    resourceName: `${name}-*`,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  })
  const logGroupPrefix = '/aws/bedrock-agentcore/runtimes/'
  const logsArn = (suffix: string) => stack.formatArn({
    service: 'logs',
    resource: 'log-group',
    resourceName: suffix,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  })
  const inferenceProfileArn = stack.formatArn({
    service: 'bedrock',
    resource: 'inference-profile',
    resourceName: inferenceProfileId,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  })
  const role = new Role(stack, 'AgentRuntimeRole', {
    assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com', {
      conditions: {
        StringEquals: { 'aws:SourceAccount': stack.account },
        ArnLike: { 'aws:SourceArn': runtimeArnPattern },
      },
    }),
    inlinePolicies: {
      RuntimeAccess: new PolicyDocument({
        statements: [
          new PolicyStatement({
            actions: ['s3:GetObject'],
            resources: [artifact.bucket.arnForObjects(artifact.s3ObjectKey)],
          }),
          new PolicyStatement({
            actions: ['bedrock:InvokeModelWithResponseStream'],
            resources: [inferenceProfileArn],
          }),
          new PolicyStatement({
            actions: ['bedrock:InvokeModelWithResponseStream'],
            resources: inferenceRegions.map(region => stack.formatArn({
              service: 'bedrock',
              region,
              account: '',
              resource: 'foundation-model',
              resourceName: modelId,
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            })),
            conditions: { StringEquals: { 'bedrock:InferenceProfileArn': inferenceProfileArn } },
          }),
          new PolicyStatement({
            actions: ['lambda:InvokeFunction'],
            resources: [paymentTools.functionArn],
          }),
          new PolicyStatement({
            actions: ['logs:CreateLogGroup', 'logs:DescribeLogStreams', 'logs:PutResourcePolicy'],
            resources: [logsArn(`${logGroupPrefix}${name}-*`)],
          }),
          new PolicyStatement({
            actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [logsArn(`${logGroupPrefix}${name}-*:log-stream:*`)],
          }),
          new PolicyStatement({
            actions: ['logs:DescribeLogGroups'],
            resources: [logsArn('*')],
          }),
        ],
      }),
    },
  })

  return new CfnRuntime(stack, 'PaymentAgentRuntime', {
    agentRuntimeName: name,
    description: 'Agente Strands para compras simuladas',
    roleArn: role.roleArn,
    protocolConfiguration: 'HTTP',
    networkConfiguration: { networkMode: 'PUBLIC' },
    agentRuntimeArtifact: {
      codeConfiguration: {
        runtime: 'PYTHON_3_13',
        entryPoint: ['app.py'],
        code: { s3: { bucket: artifact.s3BucketName, prefix: artifact.s3ObjectKey } },
      },
    },
    environmentVariables: {
      BEDROCK_MODEL_ID: inferenceProfileId,
      PAYMENT_TOOLS_ARN: paymentTools.functionArn,
    },
  })
}
