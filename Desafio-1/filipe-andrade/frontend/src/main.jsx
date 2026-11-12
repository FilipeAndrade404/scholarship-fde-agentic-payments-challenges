import { Authenticator, translations } from '@aws-amplify/ui-react'
import '@aws-amplify/ui-react/styles.css'
import { Amplify } from 'aws-amplify'
import { fetchAuthSession } from 'aws-amplify/auth'
import { I18n } from 'aws-amplify/utils'
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import { chatRequest, readChatStream } from './api.js'
import './styles.css'

const errorText = error => error instanceof TypeError
  ? 'Falha de conexão com o chat. Verifique sua rede.'
  : error.message

function Chat({ apiUrl, user, signOut }) {
  const storageKey = `pagamentos:conversa:${user.userId}`
  const [session, setSession] = useState(() => {
    const id = sessionStorage.getItem(storageKey)
    return { id: id ?? crypto.randomUUID(), restore: Boolean(id) }
  })
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(session.restore)
  const [error, setError] = useState('')
  const [controller, setController] = useState(null)

  async function getToken() {
    try {
      return (await fetchAuthSession()).tokens?.idToken?.toString()
    } catch {
      return undefined
    }
  }

  useEffect(() => {
    if (!session.restore) return
    const request = new AbortController()
    chatRequest(apiUrl, getToken, `conversas/${session.id}`, { signal: request.signal })
      .then(response => response.json())
      .then(data => setMessages(data.mensagens))
      .catch(error => {
        if (!request.signal.aborted) setError(errorText(error))
      })
      .finally(() => {
        if (!request.signal.aborted) setBusy(false)
      })
    return () => request.abort()
  }, [apiUrl, session])

  useEffect(() => () => controller?.abort(), [controller])

  async function send(event) {
    event.preventDefault()
    const message = draft.trim()
    if (!message || busy) return
    const request = new AbortController()
    const previous = messages
    setController(request)
    setDraft('')
    setError('')
    setBusy(true)
    setMessages([...previous, { role: 'user', content: message }])
    try {
      sessionStorage.setItem(storageKey, session.id)
      const response = await chatRequest(apiUrl, getToken, 'chat', {
        method: 'POST',
        body: JSON.stringify({ sessao_id: session.id, mensagem: message }),
        signal: request.signal,
      })
      let answer = ''
      await readChatStream(response, text => {
        answer += text
        setMessages([...previous, { role: 'user', content: message }, { role: 'assistant', content: answer }])
      })
    } catch (error) {
      if (!request.signal.aborted) {
        setMessages(previous)
        setError(errorText(error))
      }
    } finally {
      if (!request.signal.aborted) {
        setBusy(false)
        setController(null)
      }
    }
  }

  function newConversation() {
    sessionStorage.removeItem(storageKey)
    setSession({ id: crypto.randomUUID(), restore: false })
    setMessages([])
    setError('')
    setDraft('')
  }

  function reloadHistory() {
    setError('')
    setBusy(true)
    setSession({ id: session.id, restore: true })
  }

  return <main className="chat">
    <header>
      <h1>Assistente de pagamentos</h1>
      <nav aria-label="Conversa">
        <button onClick={newConversation} disabled={busy}>Nova conversa</button>
        <button onClick={signOut}>Sair</button>
      </nav>
    </header>
    <section className="messages" aria-label="Mensagens">
      {!messages.length && <p>Consulte o catálogo, seu limite ou acompanhe uma compra.</p>}
      {messages.map(({ role, content }, index) => <article key={index} className={role}>
        <strong>{role === 'user' ? 'Você' : 'Assistente'}</strong>
        {role === 'assistant' ? <Markdown skipHtml>{content}</Markdown> : <p>{content}</p>}
      </article>)}
    </section>
    {busy && <p role="status">Aguarde…</p>}
    {error && <div role="alert">{error} <button onClick={reloadHistory} disabled={busy}>Consultar histórico</button></div>}
    <form onSubmit={send}>
      <label htmlFor="message">Mensagem</label>
      <textarea id="message" rows={2} maxLength={4000} value={draft}
        onChange={event => setDraft(event.target.value)} />
      <button type="submit" disabled={busy || !draft.trim()}>Enviar</button>
    </form>
  </main>
}

const root = createRoot(document.getElementById('root'))

async function start() {
  const response = await fetch('/config.json', { cache: 'no-store' })
  if (!response.ok) throw new Error('Configuração indisponível')
  const { apiUrl, userPoolId, userPoolClientId } = await response.json()
  if (typeof apiUrl !== 'string' || !apiUrl.startsWith('https://') || !userPoolId || !userPoolClientId) {
    throw new Error('Configuração inválida')
  }
  Amplify.configure({ Auth: { Cognito: { userPoolId, userPoolClientId, loginWith: { email: true } } } })
  I18n.putVocabularies(translations)
  I18n.setLanguage('pt')
  root.render(<Authenticator hideSignUp loginMechanisms={['email']}>
    {({ user, signOut }) => user && <Chat key={user.userId} apiUrl={apiUrl} user={user} signOut={signOut} />}
  </Authenticator>)
}

start().catch(() => root.render(<main role="alert">Não foi possível carregar a configuração do chat.</main>))
