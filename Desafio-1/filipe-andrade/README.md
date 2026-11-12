# Agente de pagamentos na AWS

O código da Fase 1 é a referência para o catálogo, o fluxo de compra e os contratos das ferramentas. [Projeto original](https://github.com/RickyM7/Ollama-Chat-MCP-Payments/tree/3d09a7005722e30956f2799e1f3f10d89246ebf4)

## Agente Strands

O entrypoint em `agent/app.py` usa o SDK do AgentCore. O CDK define um AgentCore Runtime HTTP em Python 3.13 e passa `BEDROCK_MODEL_ID` e `PAYMENT_TOOLS_ARN`. O pacote de implantação é um ZIP com as dependências fixadas em `agent/uv.lock` e preparadas para Linux ARM64. [Implantação direta em Python](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html)

O modelo escolhido para o Runtime é o **Amazon Nova Lite** (`amazon.nova-lite-v1:0`). Ele oferece chamadas de ferramentas e streaming com inferência na própria região `us-east-1`. O Claude Haiku 4.5 pelo endpoint `bedrock-runtime` usaria um perfil que pode encaminhar chamadas para outras regiões. [Nova Lite](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html) · [Claude Haiku 4.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html)

A Lambda do chat enviará a `mensagem` do usuário, o `historico` completo obtido do banco e o `contexto` autenticado com `usuario_id` e `sessao_id`. O agente usa esse contexto ao invocar a Lambda de ferramentas. Os parâmetros apresentados ao modelo contêm apenas os argumentos da ferramenta.

O agente responde por SSE com eventos `texto`, `erro` e `fim`. O evento `fim` carrega as mensagens do turno, incluindo as chamadas e os retornos das ferramentas. O backend deverá persistir essas mensagens e enviar ao navegador apenas o texto, as mensagens de erro e um aviso de conclusão.

Na pasta `agent`, instale as dependências com Python 3.13 e uv e execute os testes locais:

```powershell
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
```

Os testes usam o SDK do Strands com respostas simuladas do modelo e da Lambda.

## Ferramentas de pagamento

A função `handler` em `tools/src/handler.ts` encaminha as chamadas para `listar_catalogo`, `registrar_intencao` e `realizar_compra`. O evento interno contém `ferramenta`, `contexto` e `argumentos`. O contexto carrega `usuario_id` e `sessao_id` obtidos pela Lambda do chat. A integração da API deverá validar a sessão e obter o usuário da claim `sub` do Cognito antes de invocar o agente. O agente repassa esse contexto por código ao invocar a função.

A intenção dura 10 minutos e registra o preço calculado pelo backend. Uma compra aprovada consome a intenção, debita o limite, reduz o estoque e grava a transação em uma única operação condicional do DynamoDB.

### Dados das ferramentas no DynamoDB

| Variável da função | Chave de partição (string) | Conteúdo |
| --- | --- | --- |
| `PRODUCTS_TABLE` | `id` | Catálogo da Fase 1, preço em centavos e estoque |
| `USERS_TABLE` | `usuario_id` | `sub` do Cognito e `limite_centavos` |
| `INTENTS_TABLE` | `intencao_id` | Usuário, sessão, produto, quantidade, valor em centavos, validade e status |
| `TRANSACTIONS_TABLE` | `transacao_id` | Compra simulada aprovada, associada à intenção e ao usuário |

O CDK carrega os itens de `tools/src/catalog.ts` com inserções condicionais. Uma nova implantação preserva o estoque dos produtos existentes. O cadastro de usuários convidados deverá associar um limite inicial ao `sub` do Cognito.

## Infraestrutura de pagamentos

A stack CDK `filipe-andrade-desafio-1` usa `us-east-1`. Ela define as quatro tabelas acima, a Lambda de ferramentas, a função usada pelo CloudFormation para carregar o catálogo e o AgentCore Runtime. Os grupos de logs das Lambdas têm retenção de sete dias. A política de remoção exclui as tabelas e esses grupos quando a stack é destruída. Depois da remoção, confira se restaram grupos do AgentCore com o prefixo `/aws/bedrock-agentcore/runtimes/filipe_andrade_desafio_1_agent-` ou artefatos do projeto no bucket de assets do CDK.

| Role | Permissões |
| --- | --- |
| Lambda de ferramentas | `Scan` no catálogo, `GetItem` em produtos, usuários e intenções e `PutItem` em intenções. Na transação de compra, `UpdateItem` em produtos, usuários e intenções e `PutItem` em transações. |
| Lambda de carga do catálogo | `PutItem` na tabela de produtos. |
| AgentCore Runtime | Invocação com streaming do Nova Lite, invocação da Lambda de pagamentos, leitura do ZIP no S3 e operações do CloudWatch Logs usadas pelo Runtime. |

Cada role pode criar streams e gravar eventos apenas no grupo de logs da sua Lambda. A compra autoriza as operações individuais com a condição `dynamodb:EnclosingOperation`. [IAM para transações do DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

Com as dependências instaladas por `npm.cmd ci` em `tools` e `infra` e com Python 3.13 e uv disponíveis, rode `npm.cmd run synth` em `infra`. O comando compila o código, empacota a Lambda e o agente e gera o template em `infra/cdk.out`.

### Testes locais

Com Node.js 24 e o [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html) em execução na porta 8000, rode na pasta `tools`:

```powershell
npm.cmd ci
npm.cmd test
```

Se o DynamoDB Local estiver em outra porta, defina `DYNAMODB_LOCAL_PORT` antes do teste. A suíte cria tabelas de teste e as remove ao terminar.
