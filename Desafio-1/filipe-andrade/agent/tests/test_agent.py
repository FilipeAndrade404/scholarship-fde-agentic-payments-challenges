import json
import unittest
from copy import deepcopy
from io import BytesIO
from unittest.mock import Mock

from strands import Agent
from strands.agent.conversation_manager import NullConversationManager
from strands.models.model import Model

from app import SYSTEM_PROMPT, stream_turn
from payment_tools import payment_tools


class LocalModel(Model):
    def __init__(self, responses):
        self.responses = iter(responses)
        self.inputs = []
        self.tool_specs = []

    def get_config(self):
        return {"model_id": "test-local"}

    def update_config(self, **model_config):
        raise AssertionError("O teste não muda a configuração do modelo.")

    def structured_output(self, output_model, prompt, system_prompt=None, **kwargs):
        raise AssertionError("O teste usa texto e chamadas de ferramenta.")

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.inputs.append(deepcopy(messages))
        self.tool_specs = tool_specs
        response = next(self.responses)
        yield {"messageStart": {"role": "assistant"}}
        if isinstance(response, str):
            yield {"contentBlockDelta": {"delta": {"text": response}}}
            reason = "end_turn"
        else:
            name, call_id, arguments = response
            yield {"contentBlockStart": {"start": {"toolUse": {"name": name, "toolUseId": call_id}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(arguments)}}}}
            reason = "tool_use"
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": reason}}


class AgentTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.identity = {"usuario_id": "sub-cognito", "sessao_id": "conversa-1"}
        self.function = "lambda-de-pagamentos"
        self.client = Mock()
        self.model = None

    def factory(self, context, history):
        return Agent(
            model=self.model,
            system_prompt=SYSTEM_PROMPT,
            tools=payment_tools(self.client, self.function, context),
            messages=history,
            conversation_manager=NullConversationManager(),
            callback_handler=None,
        )

    async def turn(self, message, history=None):
        payload = {"contexto": self.identity, "mensagem": message, "historico": history or []}
        return [event async for event in stream_turn(payload, self.factory)]

    @staticmethod
    def reply(result, **fields):
        return {"StatusCode": 200, "Payload": BytesIO(json.dumps(result).encode("utf-8")), **fields}

    def assert_lambda_call(self, name, arguments):
        args = self.client.invoke.call_args.kwargs
        self.assertEqual(args["FunctionName"], self.function)
        self.assertEqual(args["InvocationType"], "RequestResponse")
        self.assertEqual(json.loads(args["Payload"]), {
            "ferramenta": name, "contexto": self.identity, "argumentos": arguments,
        })

    async def test_catalog_stream_and_context_outside_model_schema(self):
        self.model = LocalModel([
            ("listar_catalogo", "call-1", {"categoria": "audio"}),
            "O fone custa R$ 249,90.",
        ])
        self.client.invoke.return_value = self.reply({"produtos": [{"id": "prod_003", "preco": 249.9}]})

        events = await self.turn("Mostre os itens de áudio.")

        self.assert_lambda_call("listar_catalogo", {"categoria": "audio"})
        self.assertEqual(events[0], {"tipo": "texto", "texto": "O fone custa R$ 249,90."})
        self.assertEqual(events[-1]["tipo"], "fim")
        self.assertEqual(len(events), 2)
        fields = {
            spec["name"]: set(spec["inputSchema"]["json"]["properties"])
            for spec in self.model.tool_specs
        }
        self.assertEqual(fields, {
            "listar_catalogo": {"categoria"},
            "registrar_intencao": {"produto_id", "quantidade"},
            "realizar_compra": {"intencao_id", "metodo_pagamento"},
        })

    async def test_preserves_tool_history_between_turns_and_passes_purchase_refusal(self):
        self.model = LocalModel([
            ("registrar_intencao", "intent-1", {"produto_id": "prod_003", "quantidade": 1}),
            "Fone por R$ 249,90. Prefere Pix ou cartão?",
        ])
        self.client.invoke.return_value = self.reply({"intencao_id": "int_123", "status": "pendente"})
        events = await self.turn("Quero comprar o fone.")
        self.assert_lambda_call("registrar_intencao", {"produto_id": "prod_003", "quantidade": 1})
        history = events[-1]["mensagens"]
        previous_messages = deepcopy(history)
        self.assertIn("int_123", json.dumps(history))

        self.model = LocalModel([
            ("realizar_compra", "purchase-1", {"intencao_id": "int_123", "metodo_pagamento": "pix"}),
            "Compra recusada por limite insuficiente.",
        ])
        self.client.invoke.return_value = self.reply({
            "status": "recusado", "erro": "LIMITE_EXCEDIDO", "mensagem": "Limite insuficiente.",
        })
        result = await self.turn("Pix, por favor.", history)
        self.assert_lambda_call("realizar_compra", {"intencao_id": "int_123", "metodo_pagamento": "pix"})
        self.assertEqual(self.model.inputs[0][:-1], previous_messages)
        self.assertEqual(result[-1]["mensagens"][0]["content"], [{"text": "Pix, por favor."}])
        self.assertIn("LIMITE_EXCEDIDO", json.dumps(result[-1]["mensagens"]))

    async def test_tool_runtime_failure_yields_safe_uncertain_purchase_status(self):
        self.model = LocalModel([
            ("realizar_compra", "purchase-1", {"intencao_id": "int_123", "metodo_pagamento": "cartao"}),
            "Não foi possível confirmar o pagamento.",
        ])
        self.client.invoke.return_value = self.reply(
            {"errorMessage": "detalhe interno", "stackTrace": ["arquivo:linha"]},
            FunctionError="Unhandled",
        )

        with self.assertLogs("payment_tools", level="WARNING"):
            events = await self.turn("Confirmo com cartão.")

        self.assertEqual(self.client.invoke.call_count, 1)
        serialized = json.dumps(events, ensure_ascii=False)
        self.assertIn("FERRAMENTA_INDISPONIVEL", serialized)
        self.assertIn("Não tente pagar novamente", serialized)
        self.assertNotIn("detalhe interno", serialized)
        self.assertNotIn("stackTrace", serialized)

    async def test_missing_context_rejected_before_agent_creation(self):
        factory = Mock()
        result = [event async for event in stream_turn({"mensagem": "Olá"}, factory)]
        self.assertEqual(result, [{"tipo": "erro", "mensagem": "Contexto autenticado inválido."}])
        factory.assert_not_called()
