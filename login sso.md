# Login SSO na AWS via CLI (IAM Identity Center)

Este tutorial mostra como autenticar o AWS CLI com o **IAM Identity Center (SSO)**. Com o SSO, você usa credenciais temporárias que expiram sozinhas, sem criar nem guardar chaves de acesso.

> **Nunca crie access keys de usuário IAM** nem coloque credenciais em `.env`, no código ou no Git. Se o login SSO não funcionar, peça ajuda em vez de usar chaves fixas.

## 1. Pré-requisitos

- **AWS CLI v2, versão 2.22.0 ou superior.** Confira com `aws --version`. Para instalar ou atualizar, siga o [guia oficial de instalação](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
- **Convite do IAM Identity Center aceito.** Você recebe um e-mail para ativar seu usuário e definir a senha e o MFA.
- **Dados fornecidos pela coordenação:**
  - **SSO start URL**, no formato `https://academy-compass.awsapps.com/start`;
  - **SSO region**, a região onde o Identity Center está configurado (pode ser diferente de us-east-1).

## 2. Configurar o perfil (uma única vez)

Rode o assistente:

```bash
aws configure sso
```

Responda às perguntas assim:

```
SSO session name (Recommended): fellows
SSO start URL [None]: https://<organizacao>.awsapps.com/start
SSO region [None]: <regiao-do-sso>
SSO registration scopes [sso:account:access]:        ← apenas Enter
```

O navegador abre a página de login. Entre com seu usuário do Identity Center e clique em **Allow** para autorizar o CLI.

De volta ao terminal:

1. Se houver mais de uma conta ou papel (*permission set*), escolha os indicados pela coordenação.
2. Complete o restante:

```
Default client Region [None]: us-east-1
CLI default output format [None]: json
Profile name [...]: desafio-1
```

> Use **us-east-1** como região padrão, pois todo o desafio roda nela. Ela não precisa ser igual à *SSO region*.

O assistente grava a configuração em `~/.aws/config` (no Windows, `%USERPROFILE%\.aws\config`):

```ini
[profile desafio-1]
sso_session = fellows
sso_account_id = <id-da-conta>
sso_role_name = <permission-set>
region = us-east-1
output = json

[sso-session fellows]
sso_start_url = https://<organizacao>.awsapps.com/start
sso_region = <regiao-do-sso>
sso_registration_scopes = sso:account:access
```

## 3. Definir o perfil no terminal (padrão do desafio)

Para não repetir `--profile` em todo comando, defina o perfil **em cada terminal** que você abrir para trabalhar no desafio:

| Sistema | Comando |
|---|---|
| Linux / macOS | `export AWS_PROFILE=desafio-1` |
| Windows (PowerShell) | `$env:AWS_PROFILE = "desafio-1"` |
| Windows (CMD) | `set AWS_PROFILE=desafio-1` |

A variável vale só para o terminal atual. Ao abrir um novo terminal, rode o comando de novo. Esse é o padrão do desafio porque deixa explícito em qual conta você está trabalhando e evita deploys na conta errada.

> **Dica opcional: `direnv`.** Se você usa o [direnv](https://direnv.net/), crie um arquivo `.envrc` na raiz do repositório com `export AWS_PROFILE=desafio-1` e rode `direnv allow`. O perfil passa a ser ativado sozinho ao entrar na pasta e desativado ao sair dela.

> **Nota: se você tem uma única conta AWS**, pode deixar a variável fixa para todos os terminais. No Linux, adicione `export AWS_PROFILE=desafio-1` ao `~/.bashrc` (no macOS, ao `~/.zshrc`). No Windows, rode `setx AWS_PROFILE desafio-1`, que vale para os próximos terminais. **Não faça isso se você tiver outras contas AWS configuradas**, porque todo terminal passaria a apontar para a conta do desafio sem você perceber.

## 4. Fazer login (sempre que a sessão expirar)

Com o `AWS_PROFILE` definido, basta rodar:

```bash
aws sso login
```

O navegador abre. Confirme o acesso e clique em **Allow**.

> **`aws login` não é o mesmo que `aws sso login`.** O `aws login` usa as credenciais de login do console AWS (usuário IAM ou role federada) e **não** autentica pelo IAM Identity Center. No desafio, use sempre `aws sso login`.

Confirme que está autenticado na conta certa:

```bash
aws sts get-caller-identity
```

A resposta mostra o `Account` e um `Arn` com `AWSReservedSSO_<permission-set>`. Se aparecer um erro de token expirado, basta rodar o `aws sso login` de novo.

## 5. Usar o perfil

Com a variável definida, a AWS CLI e as ferramentas de IaC usam o perfil automaticamente:

```bash
aws s3 ls              # AWS CLI
cdk deploy             # AWS CDK
terraform apply        # Terraform (lê AWS_PROFILE)
```

> Antes de qualquer deploy, rode `aws sts get-caller-identity` para confirmar a conta.

## 6. Encerrar a sessão

```bash
aws sso logout
```

## Sem navegador (WSL, container, SSH)

Se o navegador não abrir ou você estiver em uma máquina sem interface gráfica, use a autorização por código de dispositivo. O CLI mostra uma URL e um código, que você abre e digita em qualquer outro dispositivo:

```bash
aws configure sso --use-device-code
aws sso login --use-device-code
```

## Problemas comuns

| Sintoma | Causa provável e solução |
|---|---|
| `The config profile (desafio-1) could not be found` | O nome do perfil está diferente. Confira em `~/.aws/config` ou rode `aws configure list-profiles`. |
| `Token has expired` / `Error when retrieving token from sso` | A sessão expirou. Rode `aws sso login`. |
| `AccessDenied` ao criar recursos | Papel ou conta errados. Confira com `aws sts get-caller-identity` e, se preciso, rode `aws configure sso` de novo. |
| Recursos criados em outra região | O `region` do perfil não está em `us-east-1`. Corrija em `~/.aws/config`. |
| `Unable to locate credentials` | Faltou definir o `AWS_PROFILE` neste terminal. Rode o `export` da seção 3. |
| `aws sso login` pede um perfil ou usa a conta errada | O `AWS_PROFILE` não está definido neste terminal. Rode o `export` da seção 3 antes do login. |
| Logou com `aws login`, mas os comandos falham ou caem em outra conta | `aws login` é outro mecanismo. Use `aws sso login`. |
| Assistente não pergunta *SSO session name* | AWS CLI desatualizado ou v1. Atualize para a v2 mais recente. |

## Referências

- [AWS CLI — Configurar autenticação com o IAM Identity Center](https://docs.aws.amazon.com/pt_br/cli/latest/userguide/cli-configure-sso.html)
- [AWS CLI — Instalação e atualização](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)