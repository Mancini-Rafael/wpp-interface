import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import express from 'express'
import dotenv from 'dotenv'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

dotenv.config()

const MY_WA_JID      = process.env.MY_WA_JID
const GROUP_JID      = process.env.GROUP_JID || null
const DISCOVER_MODE  = process.env.DISCOVER_MODE === 'true'
const AGENT_URL      = process.env.AGENT_URL  || 'http://localhost:8788/message'
const TRIGGER_WORD   = (process.env.TRIGGER_WORD || '@agent').toLowerCase()
const PORT           = parseInt(process.env.PORT || '8789')

// Any OpenAI-compatible /audio/transcriptions endpoint works here: Groq, a local
// whisper.cpp server, or OpenAI itself.
const TRANSCRIPTION_URL     = process.env.TRANSCRIPTION_URL || 'https://api.openai.com/v1/audio/transcriptions'
const TRANSCRIPTION_MODEL   = process.env.TRANSCRIPTION_MODEL || 'whisper-1'
const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY || process.env.OPENAI_API_KEY

if (!MY_WA_JID) {
  console.error('MY_WA_JID is not set in .env')
  process.exit(1)
}
if (GROUP_JID) {
  console.log(`Group routing enabled for ${GROUP_JID} (trigger: ${TRIGGER_WORD})`)
}
if (!TRANSCRIPTION_API_KEY) {
  console.warn('TRANSCRIPTION_API_KEY is not set — audio messages will not be transcribed')
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUTH_DIR  = join(__dirname, 'auth_info')

const logger = pino({ level: 'silent' })

let sock = null
const sentMessageIds = new Set()

async function sendToWA(jid, text) {
  const sent = await sock.sendMessage(jid, { text })
  if (sent?.key?.id) sentMessageIds.add(sent.key.id)
  console.log(`→ ${text}`)
}

async function reactToMessage(msgKey, emoji) {
  const sent = await sock.sendMessage(msgKey.remoteJid, { react: { text: emoji, key: msgKey } })
  if (sent?.key?.id) sentMessageIds.add(sent.key.id)
  console.log(`→ [react] ${emoji}`)
}

async function transcribeAudio(buffer) {
  const formData = new FormData()
  formData.append('file', new Blob([buffer], { type: 'audio/ogg; codecs=opus' }), 'audio.ogg')
  formData.append('model', TRANSCRIPTION_MODEL)
  const res = await fetch(TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TRANSCRIPTION_API_KEY}` },
    body: formData,
  })

  if (!res.ok) throw new Error(`Transcription failed: ${res.status}`)
  const data = await res.json()
  return data.text?.trim() || ''
}

function stripTriggerWord(text) {
  const escaped = TRIGGER_WORD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'gi'), '').trim()
}

async function handleMessage(msg, { isGroup = false, replyJid = null } = {}) {
  replyJid = replyJid || msg.key.remoteJidAlt || msg.key.remoteJid
  const sender = isGroup ? (msg.key.participantAlt || msg.key.participant) : replyJid

  // --- Text message ---
  const rawText =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    null

  if (rawText) {
    // Group messages: only respond when the trigger word is mentioned
    if (isGroup && !rawText.toLowerCase().includes(TRIGGER_WORD)) return
    const text = isGroup ? stripTriggerWord(rawText) : rawText.trim()
    console.log(`← [text${isGroup ? ' @group' : ''}] ${text}`)
    await forwardToAgent(replyJid, text, sender, msg.key)
    return
  }

  // --- Audio / voice note (personal chat only) ---
  if (isGroup) return
  const isAudio = !!(msg.message?.audioMessage || msg.message?.pttMessage)
  if (isAudio) {
    if (!TRANSCRIPTION_API_KEY) {
      await sendToWA(replyJid, '⚠️ Audio received but TRANSCRIPTION_API_KEY is not set')
      return
    }
    await sendToWA(replyJid, '🎙️ Transcribing…')
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage,
      })
      const transcript = await transcribeAudio(buffer)
      if (!transcript) {
        await sendToWA(replyJid, '⚠️ Could not understand audio')
        return
      }
      console.log(`← [audio transcribed] ${transcript}`)
      await sendToWA(replyJid, `🎙️ Understood: "${transcript}"`)
      await forwardToAgent(replyJid, transcript, sender, msg.key)
    } catch (err) {
      console.error('Transcription error:', err.message)
      await sendToWA(replyJid, '⚠️ Transcription failed')
    }
    return
  }
}

async function forwardToAgent(jid, text, sender = null, msgKey = null) {
  try {
    const res = await fetch(AGENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, text, sender }),
    })
    if (res.ok) {
      if (msgKey) await reactToMessage(msgKey, '🤖')
    } else {
      await sendToWA(jid, `⚠️ Agent returned ${res.status}`)
    }
  } catch (err) {
    console.error('Failed to forward to agent:', err.message)
    await sendToWA(jid, '⚠️ Agent unreachable')
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({ version, auth: state, logger, printQRInTerminal: false })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\nScan this QR code with WhatsApp:\n')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (reason === DisconnectReason.loggedOut) {
        console.log('Logged out. Delete auth_info/ and restart to re-scan QR.')
      } else {
        console.log(`Connection closed (reason: ${reason}). Reconnecting…`)
        connectToWhatsApp()
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connected ✓')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[messages.upsert] type=${type} count=${messages.length}`)
    
    if (type !== 'notify') {
      console.log(`[SKIP] type is '${type}', not 'notify'`)
      return
    }

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid
      // @lid is WhatsApp's new local identifier — fall back to the alt field which contains @s.whatsapp.net
      const effectiveJid = msg.key.remoteJidAlt || remoteJid
      const sender = msg.key.participantAlt || msg.key.participant || effectiveJid
      const msgText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[non-text]'

      console.log(`[MSG] from=${remoteJid} effective=${effectiveJid} sender=${sender} text="${msgText.substring(0, 50)}"`)

      if (remoteJid === 'status@broadcast') {
        console.log(`[SKIP] status broadcast`)
        continue
      }

      const isPersonal = effectiveJid === MY_WA_JID || remoteJid === MY_WA_JID
      const isGroup    = !!GROUP_JID && (effectiveJid === GROUP_JID || remoteJid === GROUP_JID)

      console.log(`[CHECK] isPersonal=${isPersonal} (MY_WA_JID=${MY_WA_JID}) isGroup=${isGroup}`)
      
      if (!isPersonal && !isGroup) {
        console.log(`[SKIP] not personal or group chat`)
        continue
      }

      if (sentMessageIds.has(msg.key.id)) {
        console.log(`[SKIP] message sent by us`)
        sentMessageIds.delete(msg.key.id)
        continue
      }
      
      console.log(`[HANDLE] processing message...`)
      await handleMessage(msg, { isGroup, replyJid: effectiveJid })
    }
  })
}

// --- HTTP server for agent → WhatsApp ---

const app = express()
app.use(express.json())

app.post('/send', async (req, res) => {
  const { jid, text } = req.body
  if (!jid || !text) return res.status(400).json({ error: 'jid and text are required' })
  if (!sock)          return res.status(503).json({ error: 'WhatsApp not connected yet' })
  try {
    await sendToWA(jid, text)
    res.json({ status: 'sent' })
  } catch (err) {
    console.error('Failed to send message:', err.message)
    res.status(500).json({ error: err.message })
  }
})

app.get('/health', (_req, res) => {
  res.json({ status: sock ? 'connected' : 'disconnected' })
})

app.listen(PORT, () => console.log(`wpp-interface listening on :${PORT}`))

connectToWhatsApp()
