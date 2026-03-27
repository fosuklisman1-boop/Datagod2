"use client"

import { useState, useEffect } from "react"
import { supabase } from "@/lib/supabase"
import { Copy, Plus, Trash2, RefreshCw, AlertCircle, CheckCircle2, Code2, Key } from "lucide-react"

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  is_active: boolean
  last_used_at: string | null
  created_at: string
}

export default function ApiKeysManager() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [newKeyName, setNewKeyName] = useState("")
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchKeys = async () => {
    setLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch("/api/user/keys", {
        headers: { Authorization: `Bearer ${session.access_token}` }
      })
      const data = await res.json()
      if (res.ok) setKeys(data.keys || [])
      else setError(data.error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchKeys() }, [])

  const generateKey = async () => {
    if (!newKeyName.trim()) return
    setGenerating(true)
    setError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      const res = await fetch("/api/user/keys", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ name: newKeyName }),
      })
      const data = await res.json()
      if (res.ok) {
        setGeneratedKey(data.key)
        setNewKeyName("")
        fetchKeys()
      } else {
        setError(data.error)
      }
    } finally {
      setGenerating(false)
    }
  }

  const revokeKey = async (keyId: string) => {
    if (!confirm("Are you sure you want to revoke this API key? This action cannot be undone.")) return
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch(`/api/user/keys?id=${keyId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${session.access_token}` }
    })
    if (res.ok) fetchKeys()
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="api-keys-manager">
      <div className="api-header">
        <div className="api-header-icon">
          <Code2 size={22} />
        </div>
        <div>
          <h2>Developer API</h2>
          <p>Connect your applications to Datagod using API keys</p>
        </div>
      </div>

      {/* Generated Key Banner */}
      {generatedKey && (
        <div className="generated-key-banner">
          <div className="generated-key-top">
            <div className="generated-key-title">
              <CheckCircle2 size={18} />
              <span>Your new API key — copy it now</span>
            </div>
            <span className="generated-key-warn">This key will never be shown again</span>
          </div>
          <div className="generated-key-box">
            <code>{generatedKey}</code>
            <button
              className={`copy-btn ${copied ? "copied" : ""}`}
              onClick={() => copyToClipboard(generatedKey)}
            >
              {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button className="dismiss-btn" onClick={() => setGeneratedKey(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Create New Key */}
      <div className="create-key-card">
        <h3><Key size={16} /> Create New API Key</h3>
        <div className="create-key-form">
          <input
            className="key-name-input"
            placeholder="Key name (e.g. My App)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && generateKey()}
          />
          <button
            className="generate-btn"
            onClick={generateKey}
            disabled={generating || !newKeyName.trim()}
          >
            {generating ? <RefreshCw size={16} className="spinning" /> : <Plus size={16} />}
            {generating ? "Generating..." : "Generate Key"}
          </button>
        </div>
        {error && (
          <div className="api-error">
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Active Keys List */}
      <div className="keys-list">
        <div className="keys-list-header">
          <h3>Active Keys ({keys.length} / 5)</h3>
          <button className="refresh-btn" onClick={fetchKeys}>
            <RefreshCw size={14} />
          </button>
        </div>

        {loading ? (
          <div className="keys-loading">Loading...</div>
        ) : keys.length === 0 ? (
          <div className="keys-empty">No API keys yet. Generate your first key above.</div>
        ) : (
          <div className="keys-items">
            {keys.map((key) => (
              <div key={key.id} className={`key-item ${!key.is_active ? "revoked" : ""}`}>
                <div className="key-item-info">
                  <div className="key-item-name">{key.name}</div>
                  <code className="key-item-prefix">{key.key_prefix}••••••••••••••••</code>
                  <div className="key-item-meta">
                    Created {new Date(key.created_at).toLocaleDateString()} ·{" "}
                    {key.last_used_at
                      ? `Last used ${new Date(key.last_used_at).toLocaleDateString()}`
                      : "Never used"}
                  </div>
                </div>
                <div className="key-item-actions">
                  <span className={`key-status ${key.is_active ? "active" : "inactive"}`}>
                    {key.is_active ? "Active" : "Revoked"}
                  </span>
                  {key.is_active && (
                    <button
                      className="revoke-btn"
                      onClick={() => revokeKey(key.id)}
                      title="Revoke key"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* API Documentation */}
      <div className="api-usage-card">
        <h3>API Documentation</h3>
        <p className="docs-intro">Manage your wallet and place orders programmatically. All requests require the <code>X-API-Key</code> header.</p>
        
        <div className="doc-section">
          <h4>1. Check Wallet Balance</h4>
          <div className="endpoint"><span className="method get">GET</span> /api/v1/balance</div>
          <p>Returns your current wallet balance and total spend.</p>
          <pre>{`curl -X GET https://datagod.app/api/v1/balance \\
  -H "X-API-Key: dg_live_your_key_here"`}</pre>
        </div>

        <div className="doc-section">
          <h4>2. Place Data/Airtime Order</h4>
          <div className="endpoint"><span className="method post">POST</span> /api/v1/orders</div>
          <p>Place a new order. Requires sufficient wallet balance.</p>
          <pre>{`curl -X POST https://datagod.app/api/v1/orders \\
  -H "X-API-Key: dg_live_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "network": "MTN",
    "volume_gb": 5,
    "recipient": "0541234567",
    "reference": "your_unique_txn_id"
  }'`}</pre>
        </div>

        <div className="doc-section">
          <h4>3. Check Order Status</h4>
          <div className="endpoint"><span className="method get">GET</span> /api/v1/orders?reference=&#60;ref&#62;</div>
          <p>Query the status of a specific order using your custom reference.</p>
          <pre>{`curl -X GET "https://datagod.app/api/v1/orders?reference=your_unique_txn_id" \\
  -H "X-API-Key: dg_live_your_key_here"`}</pre>
        </div>
      </div>

      <style jsx>{`
        .api-keys-manager { display: flex; flex-direction: column; gap: 20px; max-width: 720px; }
        .api-header { display: flex; gap: 14px; align-items: center; }
        .api-header-icon { width: 44px; height: 44px; border-radius: 12px; background: linear-gradient(135deg, #6366f1, #8b5cf6); display: flex; align-items: center; justify-content:: center; color: white; flex-shrink: 0; display:grid;place-items:center; }
        .api-header h2 { margin: 0; font-size: 1.15rem; font-weight: 700; }
        .api-header p { margin: 0; font-size: 0.85rem; color: #9ca3af; }
        .generated-key-banner { background: #0d2e1a; border: 1px solid #16a34a; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
        .generated-key-top { display: flex; justify-content: space-between; align-items: center; }
        .generated-key-title { display: flex; align-items: center; gap: 8px; color: #4ade80; font-weight: 600; }
        .generated-key-warn { font-size: 0.75rem; color: #f59e0b; }
        .generated-key-box { background: #050f08; border: 1px solid #166534; border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .generated-key-box code { color: #4ade80; font-size: 0.8rem; flex: 1; word-break: break-all; }
        .copy-btn { display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; border: 1px solid #16a34a; background: transparent; color: #4ade80; cursor: pointer; font-size: 0.8rem; white-space: nowrap; }
        .copy-btn.copied { background: #16a34a; color: white; }
        .dismiss-btn { align-self: flex-end; background: transparent; border: 1px solid #374151; color: #9ca3af; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 0.8rem; }
        .create-key-card { background: #111827; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; }
        .create-key-card h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; font-size: 0.95rem; color: #e5e7eb; }
        .create-key-form { display: flex; gap: 10px; }
        .key-name-input { flex: 1; background: #1f2937; border: 1px solid #374151; border-radius: 8px; padding: 10px 14px; color: #e5e7eb; font-size: 0.9rem; outline: none; }
        .key-name-input:focus { border-color: #6366f1; }
        .generate-btn { display: flex; align-items: center; gap: 8px; padding: 10px 18px; background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 600; white-space: nowrap; }
        .generate-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .spinning { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .api-error { display: flex; align-items: center; gap: 8px; color: #f87171; font-size: 0.85rem; margin-top: 10px; }
        .keys-list { background: #111827; border: 1px solid #1f2937; border-radius: 12px; overflow: hidden; }
        .keys-list-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; border-bottom: 1px solid #1f2937; }
        .keys-list-header h3 { margin: 0; font-size: 0.95rem; color: #e5e7eb; }
        .refresh-btn { background: transparent; border: 1px solid #374151; color: #9ca3af; padding: 5px 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; }
        .keys-loading, .keys-empty { padding: 30px; text-align: center; color: #6b7280; font-size: 0.9rem; }
        .key-item { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid #1f2937; }
        .key-item:last-child { border-bottom: none; }
        .key-item.revoked { opacity: 0.5; }
        .key-item-name { font-weight: 600; font-size: 0.9rem; color: #e5e7eb; margin-bottom: 4px; }
        .key-item-prefix { font-size: 0.8rem; color: #6366f1; background: #1e1b4b; padding: 2px 8px; border-radius: 4px; }
        .key-item-meta { font-size: 0.75rem; color: #6b7280; margin-top: 5px; }
        .key-item-actions { display: flex; align-items: center; gap: 10px; }
        .key-status { font-size: 0.75rem; padding: 3px 10px; border-radius: 20px; font-weight: 600; }
        .key-status.active { background: #052e16; color: #4ade80; }
        .key-status.inactive { background: #2d1b1b; color: #f87171; }
        .revoke-btn { background: transparent; border: 1px solid #374151; color: #ef4444; padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; }
        .revoke-btn:hover { background: #2d1b1b; }
        .api-usage-card { background: #0c0c0c; border: 1px solid #1f2937; border-radius: 12px; padding: 20px; }
        .api-usage-card h3 { margin: 0 0 8px; font-size: 0.9rem; color: #e5e7eb; }
        .api-usage-card p { margin: 0 0 12px; font-size: 0.85rem; color: #9ca3af; }
        .api-usage-card pre { margin: 0; background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 14px; font-size: 0.8rem; color: #a5b4fc; overflow-x: auto; }
        .api-usage-card code { color: #818cf8; }
        .docs-intro { font-size: 0.85rem; color: #9ca3af; margin-bottom: 20px; line-height: 1.5; }
        .doc-section { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #1f2937; }
        .doc-section:last-child { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
        .doc-section h4 { margin: 0 0 10px; font-size: 0.9rem; color: #e5e7eb; display: flex; align-items: center; gap: 8px; }
        .endpoint { display: flex; align-items: center; gap: 10px; font-family: monospace; font-size: 0.85rem; color: #e5e7eb; background: #111827; padding: 6px 12px; border-radius: 6px; border: 1px solid #1f2937; margin-bottom: 12px; }
        .method { padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 0.75rem; color: white; }
        .method.get { background: #0ea5e9; }
        .method.post { background: #10b981; }
        .doc-section p { font-size: 0.8rem; color: #9ca3af; margin-bottom: 12px; }
      `}</style>
    </div>
  )
}
