import { fileURLToPath } from 'node:url'
import { ArnFormat, Aspects, CfnOutput, RemovalPolicy, type Stack } from 'aws-cdk-lib'
import { CachePolicy, Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { CfnPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { BucketDeployment, Source, type ISource } from 'aws-cdk-lib/aws-s3-deployment'

export function addFrontendHosting(stack: Stack) {
  const bucket = new Bucket(stack, 'FrontendBucket', {
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.DESTROY,
    versioned: false,
  })
  const origin = S3BucketOrigin.withOriginAccessControl(bucket)
  const distribution = new Distribution(stack, 'FrontendDistribution', {
    comment: `${stack.stackName}-frontend`,
    defaultRootObject: 'index.html',
    defaultBehavior: {
      origin,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    },
    additionalBehaviors: {
      'config.json': {
        origin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_DISABLED,
      },
    },
  })
  const url = `https://${distribution.distributionDomainName}`
  new CfnOutput(stack, 'FrontendUrl', { value: url })
  return { bucket, distribution, url }
}

export function publishFrontend(
  stack: Stack,
  hosting: ReturnType<typeof addFrontendHosting>,
  config: { apiUrl: string; userPoolId: string; userPoolClientId: string },
) {
  const logGroup = new LogGroup(stack, 'FrontendDeploymentLogs', {
    logGroupName: `/aws/lambda/${stack.stackName}-frontend-deployment`,
    retention: RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  })
  const role = new Role(stack, 'FrontendDeploymentRole', {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  })
  const archiveArns: string[] = []
  const archiveSources: ISource[] = [
    Source.asset(fileURLToPath(new URL('../frontend/dist', import.meta.url))),
    Source.jsonData('config.json', config),
  ]
  new BucketDeployment(stack, 'FrontendDeployment', {
    role,
    logGroup,
    destinationBucket: hosting.bucket,
    distribution: hosting.distribution,
    distributionPaths: ['/*'],
    retainOnDelete: false,
    outputObjectKeys: false,
    sources: archiveSources.map(source => ({
      bind(scope, context) {
        const archive = source.bind(scope, context)
        archiveArns.push(archive.bucket.arnForObjects(archive.zipObjectKey))
        return archive
      },
    })),
  })

  const distributionArn = stack.formatArn({
    service: 'cloudfront',
    region: '',
    resource: 'distribution',
    resourceName: hosting.distribution.distributionId,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  })
  // Substitute the generated grants on this dedicated role with the actions used by the handler.
  const access = new PolicyDocument({ statements: [
    new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: archiveArns,
    }),
    new PolicyStatement({
      actions: ['s3:GetBucketTagging', 's3:ListBucket'],
      resources: [hosting.bucket.bucketArn],
    }),
    new PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
      resources: [hosting.bucket.arnForObjects('*')],
    }),
    new PolicyStatement({
      actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
      resources: [distributionArn],
    }),
    new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [stack.formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: `${logGroup.logGroupName}:log-stream:*`,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      })],
    }),
  ] })
  Aspects.of(role).add({
    visit(node) {
      if (node instanceof CfnPolicy) node.policyDocument = access
    },
  })
}
