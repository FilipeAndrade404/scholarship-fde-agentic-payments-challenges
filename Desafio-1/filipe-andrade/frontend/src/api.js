export async function chatRequest(apiUrl, getToken, path, options = {}) {
  const token = await getToken()
  if (!token) throw new Error('Sua sessão expirou. Saia e entre novamente.')
  const headers = { Authorization: `Bearer ${token}` }
  if (options.body) headers['Content-Type'] = 'application/json'
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/${path}`, { ...options, headers })
  if (response.status === 401) throw new Error('Sua sessão expirou. Saia e entre novamente.')
  if (response.status === 409) throw new Error('Já existe uma resposta em andamento nesta conversa.')
  if (!response.ok) throw new Error('Não foi possível acessar a conversa.')
  return response
}

export async function readChatStream(response, onText) {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader()
  if (!reader) throw new Error('A resposta do chat está indisponível.')
  let pending = ''
  function readLine(line) {
    if (!line.trim()) return false
    const event = JSON.parse(line)
    if (event.error) throw new Error('Não foi possível confirmar o resultado. Consulte o histórico antes de reenviar.')
    if (typeof event.message?.content === 'string') onText(event.message.content)
    return event.done === true
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        if (readLine(pending)) return
        throw new Error('A resposta foi interrompida. Consulte o histórico antes de reenviar.')
      }
      const lines = (pending + value).split('\n')
      pending = lines.pop()
      for (const line of lines) {
        if (readLine(line)) return
      }
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('O chat recebeu uma resposta inválida.')
    throw error
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
