# Agente de pagamentos na AWS

O código da Fase 1 é a referência para o catálogo, o fluxo de compra e os contratos das ferramentas. [Projeto original](https://github.com/RickyM7/Ollama-Chat-MCP-Payments/tree/3d09a7005722e30956f2799e1f3f10d89246ebf4)

## Agente Strands

O entrypoint em `agent/app.py` usa o SDK do AgentCore. O Runtime deverá receber `BEDROCK_MODEL_ID` e `PAYMENT_TOOLS_ARN` pelo CDK. A integração com o Bedrock usa o endpoint de `us-east-1`.

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

A stack CDK `filipe-andrade-desafio-1` usa `us-east-1`. Ela define as quatro tabelas acima, a Lambda de ferramentas e a função usada pelo CloudFormation para carregar o catálogo. Os grupos do CloudWatch Logs têm retenção de sete dias. A política de remoção exclui as tabelas e os grupos de logs quando a stack é destruída.

| Role | Permissões |
| --- | --- |
| Lambda de ferramentas | `Scan` no catálogo, `GetItem` em produtos, usuários e intenções e `PutItem` em intenções. Na transação de compra, `UpdateItem` em produtos, usuários e intenções e `PutItem` em transações. |
| Lambda de carga do catálogo | `PutItem` na tabela de produtos. |

Cada role pode criar streams e gravar eventos apenas no grupo de logs da sua Lambda. A compra autoriza as operações individuais com a condição `dynamodb:EnclosingOperation`. [IAM para transações do DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

Com as dependências instaladas por `npm.cmd ci` em `tools` e `infra`, rode `npm.cmd run synth` em `infra`. O comando compila o código, empacota a Lambda e gera o template em `infra/cdk.out`.

### Testes locais

Com Node.js 24 e o [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.DownloadingAndRunning.html) em execução na porta 8000, rode na pasta `tools`:

```powershell
npm.cmd ci
npm.cmd test
```

Se o DynamoDB Local estiver em outra porta, defina `DYNAMODB_LOCAL_PORT` antes do teste. A suíte cria tabelas de teste e as remove ao terminar.
