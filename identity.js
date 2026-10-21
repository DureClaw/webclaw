// webclaw agent identity (v0.9.0) — Web Bot Auth style HTTP Message
// Signatures (RFC 9421, Ed25519) for requests the extension itself makes
// ([FETCH]). Runs in the background SW (importScripts) and in Node (tests,
// CLI) — WebCrypto only. Page navigations are NOT signed (an extension cannot
// sign per-request headers on navigations); this identifies the fleet's own
// fetches as "an agent acting for this user", the counterpart of cloud
// browsers' signed-agent programs.
//
// Header shape follows the Web Bot Auth drafts as deployed by Cloudflare
// (Signature-Agent as an sf-string, tag="web-bot-auth"); the drafts are still
// moving, so treat the exact field set as provisional.
(function (root) {
  const subtle = (root.crypto || globalThis.crypto).subtle;
  const enc = new TextEncoder();

  function b64(bytes) {
    let s = "";
    const u = new Uint8Array(bytes);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  }
  const b64url = (bytes) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function unb64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  async function generateKey() {
    const kp = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const privateJwk = await subtle.exportKey("jwk", kp.privateKey);
    const publicJwk = await subtle.exportKey("jwk", kp.publicKey);
    return { privateJwk, publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x } };
  }

  // RFC 7638 JWK thumbprint (members in lexicographic order: crv, kty, x)
  async function thumbprint(jwk) {
    const json = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
    return b64url(await subtle.digest("SHA-256", enc.encode(json)));
  }

  function authorityOf(url) {
    const u = new URL(url);
    const defaultPort = (u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80");
    return u.hostname.toLowerCase() + (u.port && !defaultPort ? ":" + u.port : "");
  }

  function paramsString(components, p) {
    return "(" + components.map((c) => '"' + c + '"').join(" ") + ")" +
      ";created=" + p.created + ";expires=" + p.expires + ';keyid="' + p.keyid + '";alg="ed25519"' +
      ';nonce="' + p.nonce + '";tag="web-bot-auth"';
  }

  function signatureBase(url, signatureAgent, params) {
    const lines = ['"@authority": ' + authorityOf(url)];
    if (signatureAgent) lines.push('"signature-agent": ' + signatureAgent);
    lines.push('"@signature-params": ' + params);
    return lines.join("\n");
  }

  // → headers to add to the request
  async function signRequest(url, key, opts) {
    opts = opts || {};
    const now = Math.floor((opts.now || Date.now()) / 1000);
    const keyid = await thumbprint(key.publicJwk);
    const nonceBytes = new Uint8Array(16);
    (root.crypto || globalThis.crypto).getRandomValues(nonceBytes);
    const sa = opts.agentUrl ? '"' + opts.agentUrl + '"' : "";
    const components = sa ? ["@authority", "signature-agent"] : ["@authority"];
    const params = paramsString(components, { created: now, expires: now + (opts.ttlSec || 60), keyid, nonce: b64url(nonceBytes) });
    const priv = await subtle.importKey("jwk", Object.assign({}, key.privateJwk, { key_ops: ["sign"] }), { name: "Ed25519" }, false, ["sign"]);
    const sig = await subtle.sign({ name: "Ed25519" }, priv, enc.encode(signatureBase(url, sa, params)));
    const headers = { "Signature-Input": "sig1=" + params, "Signature": "sig1=:" + b64(sig) + ":" };
    if (sa) headers["Signature-Agent"] = sa;
    return headers;
  }

  // Verifier (tests / reference servers). → { ok, keyid, reason? }
  async function verifyRequest(url, headers, publicJwk, nowMs) {
    const get = (k) => headers[k] || headers[k.toLowerCase()];
    const input = get("Signature-Input"), sigH = get("Signature");
    if (!input || !sigH) return { ok: false, reason: "missing headers" };
    const params = input.replace(/^sig1=/, "");
    const created = Number((params.match(/;created=(\d+)/) || [])[1]);
    const expires = Number((params.match(/;expires=(\d+)/) || [])[1]);
    const keyid = (params.match(/;keyid="([^"]+)"/) || [])[1];
    const now = Math.floor((nowMs || Date.now()) / 1000);
    if (!/tag="web-bot-auth"/.test(params)) return { ok: false, reason: "wrong tag" };
    if (!(created <= now + 5 && now <= expires)) return { ok: false, reason: "expired" };
    if (keyid !== await thumbprint(publicJwk)) return { ok: false, reason: "unknown keyid" };
    const sa = /"signature-agent"/.test(params) ? get("Signature-Agent") : "";
    const pub = await subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]);
    const sig = unb64(sigH.replace(/^sig1=:/, "").replace(/:$/, ""));
    const ok = await subtle.verify({ name: "Ed25519" }, pub, sig, enc.encode(signatureBase(url, sa, params)));
    return ok ? { ok: true, keyid } : { ok: false, reason: "bad signature" };
  }

  // Key directory to host at /.well-known/http-message-signatures-directory
  async function directory(publicJwk) {
    return { keys: [Object.assign({ kid: await thumbprint(publicJwk) }, publicJwk)] };
  }

  const api = { generateKey, thumbprint, signRequest, verifyRequest, directory, signatureBase, authorityOf };
  root.WcIdentity = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
