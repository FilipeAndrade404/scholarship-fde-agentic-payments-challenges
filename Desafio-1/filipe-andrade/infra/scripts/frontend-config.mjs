// Gera frontend/public/config.json a partir dos outputs da stack, para rodar o frontend localmente.
// Usa infra/cdk-outputs.json (criado pelo `npm run deploy`) ou, se ele não existir,
// consulta a stack já publicada com a AWS CLI (perfil e região do terminal atual).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const stackName = 'filipe-andrade-desafio-1'
const outputsFile = fileURLToPath(new URL('../cdk-outputs.json', import.meta.url))
const publicDir = fileURLToPath(new URL('../../frontend/public/', import.meta.url))
const configFile = `${publicDir}config.json`

function readOutputs() {
  if (existsSync(outputsFile)) {
    const outputs = JSON.parse(readFileSync(outputsFile, 'utf8'))[stackName]
    if (outputs) return outputs
  }
  console.log('cdk-outputs.json não encontrado; consultando a stack na AWS...')
  const raw = execFileSync('aws', [
    'cloudformation', 'describe-stacks',
    '--stack-name', stackName,
    '--region', 'us-east-1',
    '--query', 'Stacks[0].Outputs',
    '--output', 'json',
  ], { encoding: 'utf8' })
  return Object.fromEntries(JSON.parse(raw).map(output => [output.OutputKey, output.OutputValue]))
}

const outputs = readOutputs()
const config = {
  apiUrl: outputs.ChatApiUrl,
  userPoolId: outputs.CognitoUserPoolId,
  userPoolClientId: outputs.CognitoUserPoolClientId,
}
const missing = Object.entries(config).filter(([, value]) => !value).map(([key]) => key)
if (missing.length) {
  console.error(`Outputs ausentes na stack ${stackName}: ${missing.join(', ')}. O deploy terminou com sucesso?`)
  process.exit(1)
}

mkdirSync(publicDir, { recursive: true })
writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`)
console.log(`Configuração do frontend gravada em frontend/public/config.json`)
console.log(`Origem liberada no CORS: ${outputs.FrontendOrigin ?? '(frontend publicado no CloudFront)'}`)
console.log('Próximo passo: cd ../frontend && npm ci && npm run dev  ->  http://localhost:5173')
