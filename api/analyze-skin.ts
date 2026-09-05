import type { VercelRequest, VercelResponse } from '@vercel/node'

const N8N_WEBHOOK_URL = 'https://matifimran.app.n8n.cloud/webhook/analyze-skin'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body),
    })

    const data = await response.json()
    return res.status(response.status).json(data)
  } catch {
    return res.status(502).json({ error: 'Failed to reach analysis service' })
  }
}
