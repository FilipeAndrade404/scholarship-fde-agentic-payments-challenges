import asyncio
import json
import logging
from typing import TYPE_CHECKING, Literal, TypedDict

from botocore.exceptions import BotoCoreError, ClientError
from strands import tool

if TYPE_CHECKING:
    from botocore.client import BaseClient


class PaymentContext(TypedDict):
    usuario_id: str
    sessao_id: str


logger = logging.getLogger(__name__)

CONFIRMATION_REQUIRED = {
    "status": "recusado",
    "erro": "CONFIRMACAO_PENDENTE",
    "mensagem": (
        "A intenção acabou de ser registrada e o cliente ainda não confirmou. "
        "Nenhum pagamento foi feito. Mostre produto, quantidade, valor e método "
        "e peça a confirmação do cliente antes de pagar."
    ),
}


def payment_tools(client: "BaseClient", function_arn: str, context: PaymentContext):
    # As ferramentas são criadas a cada turno. Uma intenção registrada no turno atual
    # só pode ser paga depois que o cliente confirmar, em um turno seguinte.
    intents_this_turn: set[str] = set()

    async def invoke(name: str, arguments: dict) -> dict:
        def request():
            response = client.invoke(
                FunctionName=function_arn,
                InvocationType="RequestResponse",
                Payload=json.dumps(
                    {"ferramenta": name, "contexto": context, "argumentos": arguments}
                ).encode("utf-8"),
            )
            with response["Payload"] as body:
                if response.get("FunctionError") or response.get("StatusCode") != 200:
                    raise ValueError("Falha na execução da Lambda.")
                result = json.load(body)
            if not isinstance(result, dict):
                raise ValueError("Resposta inválida da Lambda.")
            return result

        try:
            return await asyncio.to_thread(request)
        except (BotoCoreError, ClientError, KeyError, OSError, ValueError) as error:
            logger.warning("Falha em %s (%s).", name, type(error).__name__)
            message = (
                "Não foi possível confirmar o resultado do pagamento. Não tente pagar novamente agora."
                if name == "realizar_compra"
                else "A ferramenta está indisponível. Tente novamente mais tarde."
            )
            return {"status": "erro", "erro": "FERRAMENTA_INDISPONIVEL", "mensagem": message}

    @tool
    async def listar_catalogo(categoria: str | None = None) -> dict:
        """Consulta os produtos, preços em reais e estoque.

        Args:
            categoria: Filtro opcional de categoria.
        """
        return await invoke("listar_catalogo", {"categoria": categoria} if categoria else {})

    @tool
    async def registrar_intencao(produto_id: str, quantidade: int) -> dict:
        """Registra uma intenção de compra sem movimentar dinheiro ou estoque.

        Args:
            produto_id: Identificador retornado pelo catálogo.
            quantidade: Quantidade inteira maior que zero.
        """
        result = await invoke(
            "registrar_intencao", {"produto_id": produto_id, "quantidade": quantidade}
        )
        if isinstance(result.get("intencao_id"), str):
            intents_this_turn.add(result["intencao_id"])
        return result

    @tool
    async def realizar_compra(
        intencao_id: str, metodo_pagamento: Literal["cartao", "pix"]
    ) -> dict:
        """Executa uma compra simulada pelo valor registrado na intenção.

        Args:
            intencao_id: Identificador retornado pela ferramenta registrar_intencao.
            metodo_pagamento: Método escolhido pelo usuário, cartao ou pix.
        """
        if intencao_id in intents_this_turn:
            logger.info("Pagamento aguardando a confirmação do cliente.")
            return CONFIRMATION_REQUIRED
        return await invoke(
            "realizar_compra",
            {"intencao_id": intencao_id, "metodo_pagamento": metodo_pagamento},
        )

    return [listar_catalogo, registrar_intencao, realizar_compra]
