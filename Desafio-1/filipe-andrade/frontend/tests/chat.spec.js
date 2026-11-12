import { expect, test } from '@playwright/test'

const config = {
  apiUrl: 'https://example.invalid/prod/',
  userPoolId: 'us-east-1_Example123',
  userPoolClientId: 'exampleclientid123456789',
}

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin !== baseURL) return route.abort()
    if (url.pathname === '/config.json') return route.fulfill({ json: config })
    return route.continue()
  })
})

test('mostra login sem cadastro público', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible()
  await expect(page.getByLabel('Senha', { exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: /cadastr|conta/i })).toHaveCount(0)
})

test('renderiza texto antes do fim, restaura histórico e avisa quando o streaming é interrompido', async ({ page }) => {
  await page.addInitScript(({ apiUrl, userPoolClientId }) => {
    const username = 'teste@example.invalid'
    const claims = {
      sub: 'usuario-simulado',
      'cognito:username': username,
      exp: Math.floor(Date.now() / 1000) + 300,
    }
    const jwt = tokenUse => {
      const encode = value => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
      return `${encode({ alg: 'RS256' })}.${encode({ ...claims, token_use: tokenUse })}.fixture`
    }
    const prefix = `CognitoIdentityServiceProvider.${userPoolClientId}`
    const idToken = jwt('id')
    localStorage.setItem(`${prefix}.LastAuthUser`, username)
    localStorage.setItem(`${prefix}.${username}.idToken`, idToken)
    localStorage.setItem(`${prefix}.${username}.accessToken`, jwt('access'))

    const originalFetch = window.fetch.bind(window)
    window.fetch = async (url, options) => {
      if (!String(url).startsWith(apiUrl)) return originalFetch(url, options)
      if (options.headers.Authorization !== `Bearer ${idToken}`) return new Response(null, { status: 401 })
      if (options.method !== 'POST') {
        const id = String(url).split('/').pop()
        const history = sessionStorage.getItem(`fixture:history:${id}`) ?? '[]'
        return Response.json({ mensagens: JSON.parse(history) })
      }

      const { sessao_id, mensagem } = JSON.parse(options.body)
      const encoder = new TextEncoder()
      const textEvent = content => encoder.encode(JSON.stringify({ message: { role: 'assistant', content } }) + '\n')
      const stream = new ReadableStream({
        start(controller) {
          if (mensagem === 'Simular interrupção') {
            controller.enqueue(textEvent('Resposta incompleta'))
            controller.close()
            return
          }
          controller.enqueue(textEvent('Seu limite é '))
          window.addEventListener('fixture:finish', () => {
            sessionStorage.setItem(`fixture:history:${sessao_id}`, JSON.stringify([
              { role: 'user', content: mensagem },
              { role: 'assistant', content: 'Seu limite é R$ 500.' },
            ]))
            controller.enqueue(textEvent('R$ 500.'))
            controller.enqueue(encoder.encode('{"done":true}\n'))
            controller.close()
          }, { once: true })
        },
      })
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }
  }, config)

  await page.goto('/')
  const input = page.getByLabel('Mensagem')
  const send = page.getByRole('button', { name: 'Enviar' })
  await input.fill('Qual é meu limite?')
  await send.click()
  await expect(page.getByText('Seu limite é', { exact: true })).toBeVisible()
  await expect(send).toBeDisabled()
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:finish')))
  await expect(page.getByText('Seu limite é R$ 500.')).toBeVisible()

  await page.reload()
  await expect(page.getByText('Qual é meu limite?')).toBeVisible()
  await expect(page.getByText('Seu limite é R$ 500.')).toBeVisible()
  await input.fill('Simular interrupção')
  await send.click()
  await expect(page.getByRole('alert')).toContainText('A resposta foi interrompida')
  await expect(page.getByText('Resposta incompleta')).toHaveCount(0)
  await page.getByRole('button', { name: 'Consultar histórico' }).click()
  await expect(page.getByText('Seu limite é R$ 500.')).toBeVisible()
})
