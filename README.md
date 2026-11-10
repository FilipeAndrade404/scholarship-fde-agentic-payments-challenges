# Desafio — Agente de Pagamentos na AWS

**Trilha Pagamentos Agênticos · Sprint 2 · Trabalho individual**

Levar para a AWS o chatbot da Fase 1 (login + agente de IA que faz compras simuladas com `listar_catalogo`, `registrar_intencao` e `realizar_compra`). O Ollama dá lugar a um modelo do Amazon Bedrock, o agente Strands roda no Bedrock AgentCore Runtime e toda a infraestrutura é definida como código. As regras de negócio da Fase 1 não mudam.

📄 Enunciado completo: [`desafio_1_sprint_2.pdf`](./desafio_1_sprint_2.pdf)

## Arquitetura

```
CloudFront + S3 (frontend estático, login Cognito)
        │  HTTPS + Authorization: Bearer <JWT>
        ▼
API Gateway (autorizador JWT Cognito · streaming ou WebSocket)
        ▼
Lambda do chat ──► Agente Strands no AgentCore Runtime (Bedrock · Claude Haiku)
                          ▼
                   Lambdas das tools ──► DynamoDB (usuários, conversas, intenções/transações)
```

## Regras essenciais

- Tudo em **us-east-1**.
- Bucket S3 **privado**, servido só pelo CloudFront (OAC). CORS da API aceita apenas o domínio do CloudFront.
- Cognito **sem auto cadastro** (`AllowAdminCreateUserOnly`); usuários entram por convite.
- API Gateway responde `401` sem token válido; `usuario_id` vem do `sub` do token, nunca do corpo nem do modelo.
- Valor da compra vem da intenção salva; pagamento e limite usam escritas condicionais (sem duplicidade).
- IAM de menor privilégio, sem `*` e sem `AdministratorAccess`. Nenhum segredo no Git.

## Organização

Crie a branch `fellow/<seu-nome>-desafio-1` e trabalhe somente na sua pasta:

```bash
git checkout -b fellow/<seu-nome>-desafio-1
```

```
Desafio-1/<seu-nome>/
├── frontend/  api/  agent/  tools/  infra/
└── README.md
```

## Deploy

Sem CI/CD. O deploy é feito **rodando o script IaC** (CDK, CloudFormation ou Terraform) da sua pasta `infra/`. Um único comando deve criar todo o ambiente: backend, agente, build e upload do frontend no S3 e invalidação do CloudFront. Use seu nome como prefixo da stack/recursos para não colidir com os demais.

## Entrega

Pull request da branch `fellow/<seu-nome>-desafio-1` com a pasta `Desafio-1/<seu-nome>/`. O `README.md` dela deve trazer: diagrama implementado, passo a passo de deploy, modelo usado, modelagem do DynamoDB, resumo do IAM, evidências (login, `401` sem token, compra com cartão e Pix, limite excedido, `intencao_id` inválido) e instruções de remoção.

Mantenha a aplicação no ar até a correção e crie no Cognito um usuário com o e-mail do instrutor.

## Limpeza (após a correção)

Destrua a stack e confirme no console que não restou bucket, distribuição, runtime do AgentCore, imagens no ECR, tabelas ou logs.