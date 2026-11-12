# Agente de pagamentos na AWS

O código da Fase 1 é a referência para o catálogo, o fluxo de compra e os contratos das ferramentas. [Projeto original](https://github.com/RickyM7/Ollama-Chat-MCP-Payments/tree/3d09a7005722e30956f2799e1f3f10d89246ebf4)

## Agente Strands

O entrypoint em `agent/app.py` usa o SDK do AgentCore. O CDK define um AgentCore Runtime HTTP em Python 3.13 e passa `BEDROCK_MODEL_ID` e `PAYMENT_TOOLS_ARN`. O pacote de implantação é um ZIP com as dependências fixadas em `agent/uv.lock` e preparadas para Linux ARM64. [Implantação direta em Python](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-code-deploy-python.html)

O Runtime usa **Claude Haiku 4.5**, da família recomendada pelo enunciado, com o perfil `us.anthropic.claude-haiku-4-5-20251001-v1:0`. A stack e o endpoint Bedrock ficam em `us-east-1`. O perfil US pode processar a inferência em `us-east-1`, `us-east-2` ou `us-west-2`. Antes do deploy, confirme o acesso ao modelo e se a conta permite os destinos desse perfil. [Claude Haiku 4.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html)

A Lambda do chat envia a `mensagem` do usuário, o `historico` completo obtido do banco e o `contexto` autenticado com `usuario_id` e `sessao_id`. O agente usa esse contexto ao invocar a Lambda de ferramentas. Os parâmetros apresentados ao modelo contêm apenas os argumentos da ferramenta.

O agente responde por SSE com eventos `texto`, `erro` e `fim`. O evento `fim` carrega as mensagens do turno, incluindo as chamadas e os retornos das ferramentas. A Lambda do chat persiste essas mensagens e envia ao cliente o texto, a mensagem de erro ou um aviso de conclusão.

Na pasta `agent`, instale as dependências com Python 3.13 e uv e execute os testes locais:

```powershell
uv sync --locked
uv run --locked python -m unittest discover -s tests -v
```

Os testes usam o SDK do Strands com respostas simuladas do modelo e da Lambda.

## Lambda do chat

O API Gateway Regional usa integração proxy em modo `STREAM`. A HTTP API sugerida pelo enunciado não oferece streaming nativo de resposta, que é um requisito do desafio. O autorizador do Cognito verifica o ID token enviado em `Authorization: Bearer <token>`, incluindo a audiência do app client. A Lambda obtém `usuario_id` de `requestContext.authorizer.claims.sub`. [Streaming no API Gateway REST](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)

| Operação | Contrato |
| --- | --- |
| `POST /chat` | Recebe `sessao_id` (UUID) e `mensagem`. Retorna NDJSON com trechos da resposta e um evento `done`. Uma sessão com turno em processamento recebe `409`. |
| `GET /conversas/{sessao_id}` | Retorna as mensagens públicas dos turnos concluídos da sessão do usuário autenticado. |

A tabela indicada por `CONVERSATIONS_TABLE` tem `conversa_id` como chave de partição e `ordem` como chave de ordenação numérica. O identificador da conversa deriva do `sub` e do UUID da sessão. O item de ordem zero controla a reserva do turno. Cada item posterior guarda a mensagem do usuário, o texto da resposta e as mensagens internas usadas no histórico do agente.

O CDK usa o domínio HTTPS da distribuição CloudFront como única origem CORS nas respostas da Lambda, no preflight e nas respostas de erro do API Gateway.

O frontend React é compilado durante o build da infraestrutura. Na implantação, o CDK publica os arquivos em um bucket S3 privado, acessível pelo CloudFront com OAC, gera o `config.json` com a URL da API e os IDs públicos do Cognito e invalida o cache da distribuição. O output `FrontendUrl` informa o endereço do chat.

Para testar o frontend localmente no Microsoft Edge, execute `npm.cmd ci` e `npm.cmd run test:e2e` na pasta `frontend`. Use `npm.cmd run test:e2e -- --headed` para ver o navegador. O Playwright gera o build, inicia a prévia local e simula a sessão e a API. Os cenários cobrem a tela de login sem cadastro público, streaming antes do fim da resposta, recuperação de histórico após recarregar a página e tratamento de interrupção.

Para testar com o DynamoDB Local, execute `npm.cmd ci` e `npm.cmd test` na pasta `api`. A suíte simula o streaming do AgentCore e valida a persistência, o isolamento por usuário, as chamadas simultâneas à mesma conversa e a criação do perfil de pagamentos.

### Acesso por convite

O User Pool do Cognito permite cadastro por administrador. O convite por e-mail leva uma senha temporária que o usuário troca no primeiro acesso. O app client público usa SRP. A função disparada antes da emissão de tokens associa o `sub` do usuário à tabela de pagamentos e concede R$ 500 de limite simulado inicial. A escrita condicional preserva o saldo dos usuários existentes em logins e renovações.

## Ferramentas de pagamento

A função `handler` em `tools/src/handler.ts` encaminha as chamadas para `listar_catalogo`, `registrar_intencao` e `realizar_compra`. O evento interno contém `ferramenta`, `contexto` e `argumentos`. O agente repassa o contexto recebido da Lambda do chat ao invocar a função.

A intenção dura 10 minutos e registra o preço calculado pelo backend. Uma compra aprovada consome a intenção, debita o limite, reduz o estoque e grava a transação em uma única operação condicional do DynamoDB.

### Dados das ferramentas no DynamoDB

| Variável da função | Chave de partição (string) | Conteúdo |
| --- | --- | --- |
| `PRODUCTS_TABLE` | `id` | Catálogo da Fase 1, preço em centavos e estoque |
| `USERS_TABLE` | `usuario_id` | `sub` do Cognito e `limite_centavos` |
| `INTENTS_TABLE` | `intencao_id` | Usuário, sessão, produto, quantidade, valor em centavos, validade e status |
| `TRANSACTIONS_TABLE` | `transacao_id` | Compra simulada aprovada, associada à intenção e ao usuário |

O CDK carrega os itens de `tools/src/catalog.ts` com inserções condicionais. Uma nova implantação preserva o estoque dos produtos existentes.

## Infraestrutura de pagamentos

A stack CDK `filipe-andrade-desafio-1` usa `us-east-1`. Ela define as tabelas de pagamentos e conversas, as Lambdas do chat e das ferramentas, a função de carga do catálogo e o AgentCore Runtime. Os grupos de logs das Lambdas têm retenção de sete dias. A política de remoção exclui as tabelas e esses grupos quando a stack é destruída. Depois da remoção, confira se restaram grupos do AgentCore com o prefixo `/aws/bedrock-agentcore/runtimes/filipe_andrade_desafio_1_agent-` ou artefatos do projeto no bucket de assets do CDK.

| Role | Permissões |
| --- | --- |
| Lambda de ferramentas | `Scan` no catálogo, `GetItem` em produtos, usuários e intenções e `PutItem` em intenções. Na transação de compra, `UpdateItem` em produtos, usuários e intenções e `PutItem` em transações. |
| Lambda de carga do catálogo | `PutItem` na tabela de produtos. |
| Lambda do chat | `Query`, `UpdateItem` e `PutItem` transacional na tabela de conversas e `InvokeAgentRuntime` no agente e no endpoint padrão. |
| Lambda de inicialização de usuário | `PutItem` na tabela de usuários do DynamoDB. |
| Lambda de publicação do frontend | Lê os dois arquivos ZIP do deploy, sincroniza e remove objetos do bucket do frontend, invalida somente a distribuição do projeto e grava logs no próprio grupo. |
| AgentCore Runtime | Invocação com streaming do perfil US do Claude Haiku 4.5, invocação da Lambda de pagamentos, leitura do ZIP no S3 e operações do CloudWatch Logs usadas pelo Runtime. Os ARNs do modelo nas regiões do perfil são autorizados somente via esse perfil. |

Cada role pode criar streams e gravar eventos apenas no grupo de logs da sua Lambda. A compra autoriza as operações individuais com a condição `dynamodb:EnclosingOperation`. [IAM para transações do DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

Com as dependências instaladas por `npm.cmd ci` em `api`, `tools` e `infra` e com Python 3.13 e uv disponíveis, rode `npm.cmd run synth` em `infra`. O comando compila o código, empacota as Lambdas e o agente e gera o template em `infra/cdk.out`.

### Testes locais

Com Node.js 24 e o [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html) em execução na porta 8000, rode na pasta `tools`:

```powershell
npm.cmd ci
npm.cmd test
```

Se o DynamoDB Local estiver em outra porta, defina `DYNAMODB_LOCAL_PORT` antes do teste. A suíte cria tabelas de teste e as remove ao terminar.
