import { fileURLToPath } from 'node:url'
import { ArnFormat, Aspects, CfnOutput, RemovalPolicy, type Stack } from 'aws-cdk-lib'
import { CachePolicy, Distribution, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { CfnPolicy } from 'aws-cdk-lib/aws-iam'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment'

export function addFrontendHosting(stack: Stack) {
  const bucket = new Bucket(stack, 'FrontendBucket', {
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    encryption: BucketEncryption.S3_MANAGED,
    enforceSSL: true,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
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
  const deployment = new BucketDeployment(stack, 'FrontendDeployment', {
    destinationBucket: hosting.bucket,
    distribution: hosting.distribution,
    distributionPaths: ['/*'],
    sources: [
      Source.asset(fileURLToPath(new URL('../frontend/dist', import.meta.url))),
      Source.jsonData('config.json', config),
    ],
  })

  const distributionArn = stack.formatArn({
    service: 'cloudfront',
    region: '',
    resource: 'distribution',
    resourceName: hosting.distribution.distributionId,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  })
  // BucketDeployment grants invalidation access to all distributions by default.
  Aspects.of(deployment.handlerRole).add({
    visit(node) {
      if (!(node instanceof CfnPolicy)) return
      const document = stack.resolve(node.policyDocument) as {
        Statement: { Action: string | string[]; Resource: unknown }[]
      }
      document.Statement.forEach((statement, index) => {
        if (Array.isArray(statement.Action) && statement.Action.includes('cloudfront:CreateInvalidation')) {
          node.addPropertyOverride(`PolicyDocument.Statement.${index}.Resource`, distributionArn)
        }
      })
    },
  })
}
