// Single-file starter kits for the Datagod API v2 (spec section 9). The sources are hand-written and
// kept in sync with the docs registry by starter-kits.test.ts. They must never contain a real key and
// never place a second purchase under a new reference after an unconfirmed outcome.

export interface StarterKit {
  id: "php" | "node"
  title: string
  filename: string
  language: "php" | "javascript"
  contentType: string
  runCommand: string
  source: string
}

const NODE_SOURCE = String.raw`// Datagod API v2 starter kit (Node.js 18 or newer, no dependencies).
//
// Setup:   export DATAGOD_API_KEY=<your test key>     (create one on the Developer API page)
// Run:     node datagod-starter.mjs
//
// The key is read from the DATAGOD_API_KEY environment variable and is never stored in this file.
// Start with a TEST key (prefix dg2_test_): it uses a sandbox wallet and never places real orders.
// The demo below refuses a live key unless you also set DATAGOD_ALLOW_LIVE=1.
//
// Sandbox failure numbers (data orders with a test key): the network's three-digit prefix followed by
//   0000404 -> the order fails 20 seconds after it is placed
//   0000202 -> the order stays pending forever
// Ready-made: 0240000404 (MTN), 0200000404 (Telecel), 0270000404 (AT) fail;
//             0240000202 (MTN), 0200000202 (Telecel), 0270000202 (AT) stay pending.
//
// Safety rule: never place a purchase again under a NEW reference when the outcome is unknown
// (a timeout, a network error, 409 OUTCOME_UNKNOWN or 409 REQUEST_IN_PROGRESS). buyDataSafely polls
// the SAME reference instead. A 409 REFERENCE_REUSED means the reference belongs to a different order.

import { pathToFileURL } from "node:url";

export const BASE_URL = "https://api.datagod.store/v2";
const REQUEST_TIMEOUT_MS = 30000;
const TERMINAL = ["completed", "failed", "refunded"];

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function apiKey() {
  const key = process.env.DATAGOD_API_KEY;
  if (!key) {
    throw new Error("DATAGOD_API_KEY is not set. Export your Datagod API key first (use a test key while you build).");
  }
  return key;
}

// Messages look like "OUTCOME_UNKNOWN: the outcome of ...": the code is the text before the colon.
function codeOf(message) {
  const m = /^([A-Z][A-Z0-9_]+):/.exec(String(message || ""));
  return m ? m[1] : "";
}

async function request(method, path, body) {
  const key = apiKey();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await globalThis.fetch(BASE_URL + path, {
      method,
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function failure(status, json) {
  const message = json && json.error && json.error.message ? String(json.error.message) : "Request failed with HTTP " + status;
  return new ApiError(status, codeOf(message), message);
}

export async function getBalance() {
  const { status, json } = await request("GET", "/wallet/balance");
  if (status !== 200 || !json || !json.success) throw failure(status, json);
  return json.data;
}

// Places ONE purchase. HTTP 201 is a new order, HTTP 200 is a replay of the same reference.
export async function buyData({ network, volumeGb, recipient, reference }) {
  const { status, json } = await request("POST", "/data/purchase", {
    network,
    volume_gb: volumeGb,
    recipient,
    reference,
  });
  if ((status !== 201 && status !== 200) || !json || !json.success) throw failure(status, json);
  return json.data.order;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reads the order by its reference until it is completed, failed or refunded (or the timeout passes).
export async function pollOrder(reference, { timeoutMs = 600000, intervalMs = 10000 } = {}) {
  apiKey();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const { status, json } = await request("GET", "/orders/" + encodeURIComponent(reference));
      if (status === 200 && json && json.success && json.data && json.data.order) {
        if (TERMINAL.includes(json.data.order.status)) return json.data.order;
      } else if (status !== 404 && status < 500) {
        throw failure(status, json);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // A network error while polling is not fatal: try again until the deadline.
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error("Timed out waiting for order " + reference + " to reach completed, failed or refunded. Keep polling the same reference; do not place it again.");
    }
    await sleep(intervalMs);
  }
}

// Buys data and returns the final order, without ever ordering twice for one purchase.
export async function buyDataSafely(params, pollOptions) {
  apiKey(); // refuse to start without a key, before anything is sent
  let order;
  try {
    order = await buyData(params);
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "REFERENCE_REUSED") throw err; // different content under this reference: stop
      if (err.status === 402) throw new Error("Insufficient wallet balance: top up the wallet and try again. " + err.message);
      if (err.code === "OUTCOME_UNKNOWN" || err.code === "REQUEST_IN_PROGRESS") {
        return pollOrder(params.reference, pollOptions); // same reference, never a new order
      }
      throw err;
    }
    // Timeout or network error: the order may have been placed. Poll the same reference.
    return pollOrder(params.reference, pollOptions);
  }
  if (TERMINAL.includes(order.status)) return order;
  return pollOrder(params.reference, pollOptions);
}

async function demo() {
  const key = apiKey();
  if (!key.startsWith("dg2_test_") && process.env.DATAGOD_ALLOW_LIVE !== "1") {
    throw new Error("This demo only runs with a test key. Set DATAGOD_ALLOW_LIVE=1 to place a real order with a live key.");
  }
  console.log("Balance:", await getBalance());
  const reference = "DEMO-" + Date.now();
  const order = await buyDataSafely({ network: "MTN", volumeGb: 1, recipient: "0244000001", reference });
  console.log("Order:", order);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  demo().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
`

const PHP_SOURCE = String.raw`<?php
// Datagod API v2 starter kit (PHP 7.4 or newer with the cURL extension, no other dependencies).
//
// Setup:   export DATAGOD_API_KEY=<your test key>     (create one on the Developer API page)
// Run:     php datagod-starter.php
//
// The key is read from the DATAGOD_API_KEY environment variable and is never stored in this file.
// Start with a TEST key (prefix dg2_test_): it uses a sandbox wallet and never places real orders.
// The demo below refuses a live key unless you also set DATAGOD_ALLOW_LIVE=1.
//
// Sandbox failure numbers (data orders with a test key): the network's three-digit prefix followed by
//   0000404 -> the order fails 20 seconds after it is placed
//   0000202 -> the order stays pending forever
// Ready-made: 0240000404 (MTN), 0200000404 (Telecel), 0270000404 (AT) fail;
//             0240000202 (MTN), 0200000202 (Telecel), 0270000202 (AT) stay pending.
//
// Safety rule: never place a purchase again under a NEW reference when the outcome is unknown
// (a timeout, a network error, 409 OUTCOME_UNKNOWN or 409 REQUEST_IN_PROGRESS). datagod_buy_data_safely
// polls the SAME reference instead. A 409 REFERENCE_REUSED means the reference belongs to a different order.

declare(strict_types=1);

const DATAGOD_BASE_URL = 'https://api.datagod.store/v2';
const DATAGOD_REQUEST_TIMEOUT = 30; // seconds
const DATAGOD_TERMINAL = ['completed', 'failed', 'refunded'];

class DatagodApiError extends RuntimeException
{
    public $status;
    public $errorCode;

    public function __construct(int $status, string $errorCode, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
        $this->errorCode = $errorCode;
    }
}

class DatagodNetworkError extends RuntimeException
{
}

function datagod_key(): string
{
    $key = getenv('DATAGOD_API_KEY');
    if ($key === false || $key === '') {
        throw new RuntimeException('DATAGOD_API_KEY is not set. Export your Datagod API key first (use a test key while you build).');
    }
    return $key;
}

// Messages look like "OUTCOME_UNKNOWN: the outcome of ...": the code is the text before the colon.
function datagod_code_of(string $message): string
{
    return preg_match('/^([A-Z][A-Z0-9_]+):/', $message, $m) ? $m[1] : '';
}

function datagod_request(string $method, string $path, ?array $body = null): array
{
    $key = datagod_key();
    $ch = curl_init(DATAGOD_BASE_URL . $path);
    $headers = ['Authorization: Bearer ' . $key, 'Content-Type: application/json', 'Accept: application/json'];
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, DATAGOD_REQUEST_TIMEOUT);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        throw new DatagodNetworkError('Network error: ' . $err);
    }
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $json = json_decode((string) $raw, true);
    return [$status, is_array($json) ? $json : null];
}

function datagod_failure(int $status, ?array $json): DatagodApiError
{
    $message = isset($json['error']['message']) ? (string) $json['error']['message'] : 'Request failed with HTTP ' . $status;
    return new DatagodApiError($status, datagod_code_of($message), $message);
}

function datagod_get_balance(): array
{
    [$status, $json] = datagod_request('GET', '/wallet/balance');
    if ($status !== 200 || empty($json['success'])) {
        throw datagod_failure($status, $json);
    }
    return $json['data'];
}

// Places ONE purchase. HTTP 201 is a new order, HTTP 200 is a replay of the same reference.
function datagod_buy_data(string $network, float $volumeGb, string $recipient, string $reference): array
{
    [$status, $json] = datagod_request('POST', '/data/purchase', [
        'network' => $network,
        'volume_gb' => $volumeGb,
        'recipient' => $recipient,
        'reference' => $reference,
    ]);
    if (($status !== 201 && $status !== 200) || empty($json['success'])) {
        throw datagod_failure($status, $json);
    }
    return $json['data']['order'];
}

// Reads the order by its reference until it is completed, failed or refunded (or the timeout passes).
function datagod_poll_order(string $reference, int $timeoutSeconds = 600, int $intervalSeconds = 10): array
{
    $deadline = time() + $timeoutSeconds;
    while (true) {
        try {
            [$status, $json] = datagod_request('GET', '/orders/' . rawurlencode($reference));
            if ($status === 200 && !empty($json['success']) && isset($json['data']['order'])) {
                if (in_array($json['data']['order']['status'], DATAGOD_TERMINAL, true)) {
                    return $json['data']['order'];
                }
            } elseif ($status !== 404 && $status < 500) {
                throw datagod_failure($status, $json);
            }
        } catch (DatagodNetworkError $e) {
            // A network error while polling is not fatal: try again until the deadline.
        }
        if (time() + $intervalSeconds > $deadline) {
            throw new RuntimeException('Timed out waiting for order ' . $reference . ' to reach completed, failed or refunded. Keep polling the same reference; do not place it again.');
        }
        sleep($intervalSeconds);
    }
}

// Buys data and returns the final order, without ever ordering twice for one purchase.
function datagod_buy_data_safely(string $network, float $volumeGb, string $recipient, string $reference, int $timeoutSeconds = 600, int $intervalSeconds = 10): array
{
    datagod_key(); // refuse to start without a key, before anything is sent
    try {
        $order = datagod_buy_data($network, $volumeGb, $recipient, $reference);
    } catch (DatagodApiError $e) {
        if ($e->errorCode === 'REFERENCE_REUSED') {
            throw $e; // different content under this reference: stop
        }
        if ($e->status === 402) {
            throw new RuntimeException('Insufficient wallet balance: top up the wallet and try again. ' . $e->getMessage());
        }
        if ($e->errorCode === 'OUTCOME_UNKNOWN' || $e->errorCode === 'REQUEST_IN_PROGRESS') {
            return datagod_poll_order($reference, $timeoutSeconds, $intervalSeconds); // same reference, never a new order
        }
        throw $e;
    } catch (DatagodNetworkError $e) {
        // Timeout or network error: the order may have been placed. Poll the same reference.
        return datagod_poll_order($reference, $timeoutSeconds, $intervalSeconds);
    }
    if (in_array($order['status'], DATAGOD_TERMINAL, true)) {
        return $order;
    }
    return datagod_poll_order($reference, $timeoutSeconds, $intervalSeconds);
}

function datagod_demo(): void
{
    $key = datagod_key();
    if (strpos($key, 'dg2_test_') !== 0 && getenv('DATAGOD_ALLOW_LIVE') !== '1') {
        throw new RuntimeException('This demo only runs with a test key. Set DATAGOD_ALLOW_LIVE=1 to place a real order with a live key.');
    }
    echo 'Balance: ' . json_encode(datagod_get_balance()) . "\n";
    $order = datagod_buy_data_safely('MTN', 1.0, '0244000001', 'DEMO-' . time());
    echo 'Order: ' . json_encode($order) . "\n";
}

if (PHP_SAPI === 'cli' && isset($argv[0]) && realpath($argv[0]) === __FILE__) {
    try {
        datagod_demo();
    } catch (Throwable $e) {
        fwrite(STDERR, $e->getMessage() . "\n");
        exit(1);
    }
}
`

export const STARTER_KITS: readonly StarterKit[] = [
  {
    id: "php",
    title: "PHP",
    filename: "datagod-starter.php",
    language: "php",
    contentType: "text/plain; charset=utf-8",
    runCommand: "DATAGOD_API_KEY=<your test key> php datagod-starter.php",
    source: PHP_SOURCE,
  },
  {
    id: "node",
    title: "Node.js",
    filename: "datagod-starter.mjs",
    language: "javascript",
    contentType: "text/plain; charset=utf-8",
    runCommand: "DATAGOD_API_KEY=<your test key> node datagod-starter.mjs",
    source: NODE_SOURCE,
  },
]

export function getStarterKit(id: string): StarterKit | null {
  return STARTER_KITS.find((k) => k.id === id) ?? null
}

export function starterKitResponse(id: string): Response {
  const kit = getStarterKit(id)
  if (!kit) {
    return new Response(
      JSON.stringify({ success: false, error: { code: 404, message: "Unknown starter kit" } }),
      { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } },
    )
  }
  return new Response(kit.source, {
    status: 200,
    headers: {
      "Content-Type": kit.contentType,
      "Content-Disposition": 'attachment; filename="' + kit.filename + '"',
      "Cache-Control": "public, max-age=300",
    },
  })
}
