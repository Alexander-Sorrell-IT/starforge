// @ts-nocheck
// Credential redaction + path masking + identity pseudonymisation. Everything
// passes through here BEFORE it is stored, rendered, or written to any report
// file.
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
export const REDACTED = stryMutAct_9fa48("0") ? "" : (stryCov_9fa48("0"), "[redacted]");

// Superset of the standout regex list, plus env-style assignments, ssh keys,
// hex secrets, connection-string passwords, and cloud tokens.
const SECRET_PATTERNS = stryMutAct_9fa48("1") ? [] : (stryCov_9fa48("1"), [stryMutAct_9fa48("9") ? /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[^A-Z ]*PRIVATE KEY-----/g : stryMutAct_9fa48("8") ? /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]PRIVATE KEY-----/g : stryMutAct_9fa48("7") ? /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\s]*?-----END[A-Z ]*PRIVATE KEY-----/g : stryMutAct_9fa48("6") ? /-----BEGIN[A-Z ]*PRIVATE KEY-----[\S\S]*?-----END[A-Z ]*PRIVATE KEY-----/g : stryMutAct_9fa48("5") ? /-----BEGIN[A-Z ]*PRIVATE KEY-----[^\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g : stryMutAct_9fa48("4") ? /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]-----END[A-Z ]*PRIVATE KEY-----/g : stryMutAct_9fa48("3") ? /-----BEGIN[^A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g : stryMutAct_9fa48("2") ? /-----BEGIN[A-Z ]PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g : (stryCov_9fa48("2", "3", "4", "5", "6", "7", "8", "9"), /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g), stryMutAct_9fa48("13") ? /ssh-(?:rsa|ed25519|dss|ecdsa)\s+[^A-Za-z0-9+/=]{40,}/g : stryMutAct_9fa48("12") ? /ssh-(?:rsa|ed25519|dss|ecdsa)\s+[A-Za-z0-9+/=]/g : stryMutAct_9fa48("11") ? /ssh-(?:rsa|ed25519|dss|ecdsa)\S+[A-Za-z0-9+/=]{40,}/g : stryMutAct_9fa48("10") ? /ssh-(?:rsa|ed25519|dss|ecdsa)\s[A-Za-z0-9+/=]{40,}/g : (stryCov_9fa48("10", "11", "12", "13"), /ssh-(?:rsa|ed25519|dss|ecdsa)\s+[A-Za-z0-9+/=]{40,}/g), stryMutAct_9fa48("15") ? /sk-ant-[^A-Za-z0-9_-]{20,}/g : stryMutAct_9fa48("14") ? /sk-ant-[A-Za-z0-9_-]/g : (stryCov_9fa48("14", "15"), /sk-ant-[A-Za-z0-9_-]{20,}/g), stryMutAct_9fa48("18") ? /sk-(?:proj-|live-|test-)?[^A-Za-z0-9_-]{20,}/g : stryMutAct_9fa48("17") ? /sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]/g : stryMutAct_9fa48("16") ? /sk-(?:proj-|live-|test-)[A-Za-z0-9_-]{20,}/g : (stryCov_9fa48("16", "17", "18"), /sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g), stryMutAct_9fa48("20") ? /npm_[^A-Za-z0-9]{36}/g : stryMutAct_9fa48("19") ? /npm_[A-Za-z0-9]/g : (stryCov_9fa48("19", "20"), /npm_[A-Za-z0-9]{36}/g), stryMutAct_9fa48("23") ? /gh[pousr]_[^A-Za-z0-9]{36,}/g : stryMutAct_9fa48("22") ? /gh[pousr]_[A-Za-z0-9]/g : stryMutAct_9fa48("21") ? /gh[^pousr]_[A-Za-z0-9]{36,}/g : (stryCov_9fa48("21", "22", "23"), /gh[pousr]_[A-Za-z0-9]{36,}/g), stryMutAct_9fa48("25") ? /github_pat_[^A-Za-z0-9_]{60,}/g : stryMutAct_9fa48("24") ? /github_pat_[A-Za-z0-9_]/g : (stryCov_9fa48("24", "25"), /github_pat_[A-Za-z0-9_]{60,}/g), stryMutAct_9fa48("27") ? /glpat-[^A-Za-z0-9_-]{20,}/g : stryMutAct_9fa48("26") ? /glpat-[A-Za-z0-9_-]/g : (stryCov_9fa48("26", "27"), /glpat-[A-Za-z0-9_-]{20,}/g), stryMutAct_9fa48("29") ? /AKIA[^0-9A-Z]{16}/g : stryMutAct_9fa48("28") ? /AKIA[0-9A-Z]/g : (stryCov_9fa48("28", "29"), /AKIA[0-9A-Z]{16}/g), stryMutAct_9fa48("31") ? /ASIA[^0-9A-Z]{16}/g : stryMutAct_9fa48("30") ? /ASIA[0-9A-Z]/g : (stryCov_9fa48("30", "31"), /ASIA[0-9A-Z]{16}/g), stryMutAct_9fa48("33") ? /AIza[^0-9A-Za-z_-]{35}/g : stryMutAct_9fa48("32") ? /AIza[0-9A-Za-z_-]/g : (stryCov_9fa48("32", "33"), /AIza[0-9A-Za-z_-]{35}/g), stryMutAct_9fa48("35") ? /ya29\.[^A-Za-z0-9_-]{20,}/g : stryMutAct_9fa48("34") ? /ya29\.[A-Za-z0-9_-]/g : (stryCov_9fa48("34", "35"), /ya29\.[A-Za-z0-9_-]{20,}/g), stryMutAct_9fa48("38") ? /xox[baprs]-[^A-Za-z0-9-]{10,}/g : stryMutAct_9fa48("37") ? /xox[baprs]-[A-Za-z0-9-]/g : stryMutAct_9fa48("36") ? /xox[^baprs]-[A-Za-z0-9-]{10,}/g : (stryCov_9fa48("36", "37", "38"), /xox[baprs]-[A-Za-z0-9-]{10,}/g), stryMutAct_9fa48("41") ? /[rs]k_(?:live|test)_[^A-Za-z0-9]{20,}/g : stryMutAct_9fa48("40") ? /[rs]k_(?:live|test)_[A-Za-z0-9]/g : stryMutAct_9fa48("39") ? /[^rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g : (stryCov_9fa48("39", "40", "41"), /[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g), stryMutAct_9fa48("47") ? /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[^A-Za-z0-9_-]{6,}/g : stryMutAct_9fa48("46") ? /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]/g : stryMutAct_9fa48("45") ? /eyJ[A-Za-z0-9_-]{10,}\.eyJ[^A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g : stryMutAct_9fa48("44") ? /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]\.[A-Za-z0-9_-]{6,}/g : stryMutAct_9fa48("43") ? /eyJ[^A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g : stryMutAct_9fa48("42") ? /eyJ[A-Za-z0-9_-]\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g : (stryCov_9fa48("42", "43", "44", "45", "46", "47"), /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g), // JWT
stryMutAct_9fa48("49") ? /dg_[^A-Za-z0-9]{30,}/g : stryMutAct_9fa48("48") ? /dg_[A-Za-z0-9]/g : (stryCov_9fa48("48", "49"), /dg_[A-Za-z0-9]{30,}/g), // Deepgram
stryMutAct_9fa48("51") ? /hf_[^A-Za-z0-9]{30,}/g : stryMutAct_9fa48("50") ? /hf_[A-Za-z0-9]/g : (stryCov_9fa48("50", "51"), /hf_[A-Za-z0-9]{30,}/g), // HuggingFace
stryMutAct_9fa48("53") ? /pk_(?:live|test)_[^A-Za-z0-9]{20,}/g : stryMutAct_9fa48("52") ? /pk_(?:live|test)_[A-Za-z0-9]/g : (stryCov_9fa48("52", "53"), /pk_(?:live|test)_[A-Za-z0-9]{20,}/g), stryMutAct_9fa48("60") ? /postgres(?:ql)?:\/\/[^:\s]+:[^@\S]+@/g : stryMutAct_9fa48("59") ? /postgres(?:ql)?:\/\/[^:\s]+:[@\s]+@/g : stryMutAct_9fa48("58") ? /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]@/g : stryMutAct_9fa48("57") ? /postgres(?:ql)?:\/\/[^:\S]+:[^@\s]+@/g : stryMutAct_9fa48("56") ? /postgres(?:ql)?:\/\/[:\s]+:[^@\s]+@/g : stryMutAct_9fa48("55") ? /postgres(?:ql)?:\/\/[^:\s]:[^@\s]+@/g : stryMutAct_9fa48("54") ? /postgres(?:ql):\/\/[^:\s]+:[^@\s]+@/g : (stryCov_9fa48("54", "55", "56", "57", "58", "59", "60"), /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g), // conn-string password
stryMutAct_9fa48("66") ? /mysql:\/\/[^:\s]+:[^@\S]+@/g : stryMutAct_9fa48("65") ? /mysql:\/\/[^:\s]+:[@\s]+@/g : stryMutAct_9fa48("64") ? /mysql:\/\/[^:\s]+:[^@\s]@/g : stryMutAct_9fa48("63") ? /mysql:\/\/[^:\S]+:[^@\s]+@/g : stryMutAct_9fa48("62") ? /mysql:\/\/[:\s]+:[^@\s]+@/g : stryMutAct_9fa48("61") ? /mysql:\/\/[^:\s]:[^@\s]+@/g : (stryCov_9fa48("61", "62", "63", "64", "65", "66"), /mysql:\/\/[^:\s]+:[^@\s]+@/g), stryMutAct_9fa48("73") ? /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\S]+@/g : stryMutAct_9fa48("72") ? /mongodb(?:\+srv)?:\/\/[^:\s]+:[@\s]+@/g : stryMutAct_9fa48("71") ? /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]@/g : stryMutAct_9fa48("70") ? /mongodb(?:\+srv)?:\/\/[^:\S]+:[^@\s]+@/g : stryMutAct_9fa48("69") ? /mongodb(?:\+srv)?:\/\/[:\s]+:[^@\s]+@/g : stryMutAct_9fa48("68") ? /mongodb(?:\+srv)?:\/\/[^:\s]:[^@\s]+@/g : stryMutAct_9fa48("67") ? /mongodb(?:\+srv):\/\/[^:\s]+:[^@\s]+@/g : (stryCov_9fa48("67", "68", "69", "70", "71", "72", "73"), /mongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@/g), stryMutAct_9fa48("79") ? /redis:\/\/[^:\s]*:[^@\S]+@/g : stryMutAct_9fa48("78") ? /redis:\/\/[^:\s]*:[@\s]+@/g : stryMutAct_9fa48("77") ? /redis:\/\/[^:\s]*:[^@\s]@/g : stryMutAct_9fa48("76") ? /redis:\/\/[^:\S]*:[^@\s]+@/g : stryMutAct_9fa48("75") ? /redis:\/\/[:\s]*:[^@\s]+@/g : stryMutAct_9fa48("74") ? /redis:\/\/[^:\s]:[^@\s]+@/g : (stryCov_9fa48("74", "75", "76", "77", "78", "79"), /redis:\/\/[^:\s]*:[^@\s]+@/g), stryMutAct_9fa48("81") ? /0x[^a-fA-F0-9]{64}\b/g : stryMutAct_9fa48("80") ? /0x[a-fA-F0-9]\b/g : (stryCov_9fa48("80", "81"), /0x[a-fA-F0-9]{64}\b/g), // 32-byte hex (eth private keys etc.)
// RFC1918 addresses. Not a credential, but an internal host is infrastructure
// detail about someone's network, and a wrapped is a thing people post. Found
// in a sibling tool's corpus as `Login path (PuTTY/MobaXterm -> 10.x.x.x ->
// ssh <account>@)`, which survived every rule above because none describe an
// IP. Private ranges only: a public address is indistinguishable from a
// version string or an ordinary number, and matching those would redact prose.
stryMutAct_9fa48("90") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\D{1,3}\b/g : stryMutAct_9fa48("89") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d\b/g : stryMutAct_9fa48("88") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\D{1,3}\.\d{1,3}\b/g : stryMutAct_9fa48("87") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d\.\d{1,3}\b/g : stryMutAct_9fa48("86") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[^01]))\.\d{1,3}\.\d{1,3}\b/g : stryMutAct_9fa48("85") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\D|3[01]))\.\d{1,3}\.\d{1,3}\b/g : stryMutAct_9fa48("84") ? /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[^6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g : stryMutAct_9fa48("83") ? /\b(?:10\.\D{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g : stryMutAct_9fa48("82") ? /\b(?:10\.\d|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g : (stryCov_9fa48("82", "83", "84", "85", "86", "87", "88", "89", "90"), /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g)]);

// KEY=value / key: value / "key": "value" style assignments.
const LABELED_SECRET = stryMutAct_9fa48("108") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([^A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("107") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+])/gi : stryMutAct_9fa48("106") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\S:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("105") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b([^"'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("104") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=])([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("103") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[^_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("102") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("101") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("100") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[^_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("99") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("98") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[^_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("97") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("96") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[^_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("95") ? /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("94") ? /\b(api[_-]?key|apikey|secret|secret[^_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("93") ? /\b(api[_-]?key|apikey|secret|secret[_-]key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("92") ? /\b(api[^_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : stryMutAct_9fa48("91") ? /\b(api[_-]key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi : (stryCov_9fa48("91", "92", "93", "94", "95", "96", "97", "98", "99", "100", "101", "102", "103", "104", "105", "106", "107", "108"), /\b(api[_-]?key|apikey|secret|secret[_-]?key|access[_-]?key|private[_-]?key|token|auth[_-]?token|password|passwd|pwd|authorization|bearer|credentials?|client[_-]?secret)\b(["'\s:=]{1,4})([A-Za-z0-9_\-./+]{16,})/gi);

// ENV-style: SOMETHING_KEY=longvalue, SOMETHING_TOKEN=..., SOMETHING_SECRET=...
const ENV_SECRET = stryMutAct_9fa48("117") ? /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\S"']{8,})\2/g : stryMutAct_9fa48("116") ? /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([\s"']{8,})\2/g : stryMutAct_9fa48("115") ? /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\s"'])\2/g : stryMutAct_9fa48("114") ? /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=([^"']?)([^\s"']{8,})\2/g : stryMutAct_9fa48("113") ? /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["'])([^\s"']{8,})\2/g : stryMutAct_9fa48("112") ? /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|AUTH))=(["']?)([^\s"']{8,})\2/g : stryMutAct_9fa48("111") ? /\b([A-Z][^A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\s"']{8,})\2/g : stryMutAct_9fa48("110") ? /\b([A-Z][A-Z0-9_](?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\s"']{8,})\2/g : stryMutAct_9fa48("109") ? /\b([^A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\s"']{8,})\2/g : (stryCov_9fa48("109", "110", "111", "112", "113", "114", "115", "116", "117"), /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH))=(["']?)([^\s"']{8,})\2/g);
export function redactSecrets(text) {
  if (stryMutAct_9fa48("118")) {
    {}
  } else {
    stryCov_9fa48("118");
    if (stryMutAct_9fa48("121") ? false : stryMutAct_9fa48("120") ? true : stryMutAct_9fa48("119") ? text : (stryCov_9fa48("119", "120", "121"), !text)) return text;
    let out = text;
    for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
    out = out.replace(LABELED_SECRET, stryMutAct_9fa48("122") ? () => undefined : (stryCov_9fa48("122"), (_m, label, sep) => stryMutAct_9fa48("123") ? `` : (stryCov_9fa48("123"), `${label}${sep}${REDACTED}`)));
    out = out.replace(ENV_SECRET, stryMutAct_9fa48("124") ? () => undefined : (stryCov_9fa48("124"), (_m, name) => stryMutAct_9fa48("125") ? `` : (stryCov_9fa48("125"), `${name}=${REDACTED}`)));
    return out;
  }
}

// ---- path masking ----------------------------------------------------------
const HOME = homedir();
let USER = stryMutAct_9fa48("126") ? "Stryker was here!" : (stryCov_9fa48("126"), "");
try {
  if (stryMutAct_9fa48("127")) {
    {}
  } else {
    stryCov_9fa48("127");
    USER = userInfo().username;
  }
} catch {
  if (stryMutAct_9fa48("128")) {
    {}
  } else {
    stryCov_9fa48("128");
    USER = stryMutAct_9fa48("131") ? process.env.USER && "" : stryMutAct_9fa48("130") ? false : stryMutAct_9fa48("129") ? true : (stryCov_9fa48("129", "130", "131"), process.env.USER || (stryMutAct_9fa48("132") ? "Stryker was here!" : (stryCov_9fa48("132"), "")));
  }
}

// A username shorter than this is not masked outside an explicit /user/ path:
// names like "al" or "dev" appear in ordinary words, and replacing them would
// corrupt text without protecting anyone. src/verify.mjs's output-scrub check
// imports this same constant, so what maskPath REMOVES and what the scrub
// FLAGS can never drift apart.
export const MIN_MASKABLE_USER_LEN = 4;

// Mask the home dir, the username anywhere it appears, and collapse deep local
// paths so only the project-relative tail survives.
//
// The third rule (a standalone occurrence of the username, whatever the
// surrounding punctuation) exists because slash-delimited masking is not
// enough: paths get MANGLED into single directory names, with "/" rewritten to
// something else, and the username rides along. Claude Code does exactly this —
// ~/.claude/projects/-Users-alice-Desktop-Bug — and that is a tree starreckon
// reads on every run. A found leak, not a hypothetical: a real run log here
// recorded `--join-fleet=/private/tmp/.../-Users-<name>-.../token-usage`, which
// the first two rules left untouched and the output-scrub check then flagged as
// a masking failure in our own output.
//
// The cost is a false positive: if your username is also an ordinary word, that
// word becomes [user] in report text. For a tool whose whole claim is that it
// does not write your identity into files people sync, that is the right way to
// be wrong.
export function maskPath(p) {
  if (stryMutAct_9fa48("133")) {
    {}
  } else {
    stryCov_9fa48("133");
    if (stryMutAct_9fa48("136") ? !p && typeof p !== "string" : stryMutAct_9fa48("135") ? false : stryMutAct_9fa48("134") ? true : (stryCov_9fa48("134", "135", "136"), (stryMutAct_9fa48("137") ? p : (stryCov_9fa48("137"), !p)) || (stryMutAct_9fa48("139") ? typeof p === "string" : stryMutAct_9fa48("138") ? false : (stryCov_9fa48("138", "139"), typeof p !== (stryMutAct_9fa48("140") ? "" : (stryCov_9fa48("140"), "string")))))) return p;
    let out = p;
    if (stryMutAct_9fa48("142") ? false : stryMutAct_9fa48("141") ? true : (stryCov_9fa48("141", "142"), HOME)) out = out.split(HOME).join(stryMutAct_9fa48("143") ? "" : (stryCov_9fa48("143"), "~"));
    if (stryMutAct_9fa48("145") ? false : stryMutAct_9fa48("144") ? true : (stryCov_9fa48("144", "145"), USER)) {
      if (stryMutAct_9fa48("146")) {
        {}
      } else {
        stryCov_9fa48("146");
        out = out.replace(new RegExp(stryMutAct_9fa48("147") ? `` : (stryCov_9fa48("147"), `/(?:Users|home)/${escapeRe(USER)}(?=/|$)`), stryMutAct_9fa48("148") ? "" : (stryCov_9fa48("148"), "g")), stryMutAct_9fa48("149") ? "" : (stryCov_9fa48("149"), "~"));
        out = out.split(stryMutAct_9fa48("150") ? `` : (stryCov_9fa48("150"), `/${USER}/`)).join(stryMutAct_9fa48("151") ? "" : (stryCov_9fa48("151"), "/[user]/"));
        if (stryMutAct_9fa48("155") ? USER.length < MIN_MASKABLE_USER_LEN : stryMutAct_9fa48("154") ? USER.length > MIN_MASKABLE_USER_LEN : stryMutAct_9fa48("153") ? false : stryMutAct_9fa48("152") ? true : (stryCov_9fa48("152", "153", "154", "155"), USER.length >= MIN_MASKABLE_USER_LEN)) out = out.replace(new RegExp(stryMutAct_9fa48("156") ? `` : (stryCov_9fa48("156"), `(?<![A-Za-z0-9])${escapeRe(USER)}(?![A-Za-z0-9])`), stryMutAct_9fa48("157") ? "" : (stryCov_9fa48("157"), "g")), stryMutAct_9fa48("158") ? "" : (stryCov_9fa48("158"), "[user]"));
      }
    }
    return out;
  }
}

// Reduce a cwd to a masked project label: last two path segments under ~.
//
// TWO BUGS LIVED HERE, and both wrote their canary into reports/expanded-*.json
// verbatim while profile.mjs redacted the SAME label three hundred lines away —
// so one generated file contained "[redacted]/repo" and the live value side by
// side.
//
//   1. maskPath only. maskPath rewrites HOME, and nothing else; a secret sitting
//      in a working-directory name is not a path component it knows about. A cwd
//      whose second-to-last segment was an AWS key id produced exactly that key
//      as the project name. redactSecrets has to run too, and it runs FIRST so
//      that a key is gone before any truncation decision is made about it.
//      (No example path here on purpose: this file is scanned for anything
//      home-shaped, and a comment is as readable as code.)
//
//   2. split("/") only. A Windows or UNC cwd has no forward slashes, so it is
//      one "segment", so the <= 2 early return handed back the WHOLE path:
//      "C:\Users\<person>\Projects\<client>" and "\\fileserver\share\<matter>"
//      were written in full, and unescaped into title= attributes in the HTML.
//      Splitting on both separators makes the two-segment rule mean the same
//      thing on every platform, which is what it always claimed to mean.
export function projectLabel(cwd) {
  if (stryMutAct_9fa48("159")) {
    {}
  } else {
    stryCov_9fa48("159");
    const masked = maskPath(redactSecrets(cwd));
    if (stryMutAct_9fa48("162") ? false : stryMutAct_9fa48("161") ? true : stryMutAct_9fa48("160") ? masked : (stryCov_9fa48("160", "161", "162"), !masked)) return null;
    const parts = stryMutAct_9fa48("163") ? masked.split(/[/\\]/) : (stryCov_9fa48("163"), masked.split(stryMutAct_9fa48("164") ? /[^/\\]/ : (stryCov_9fa48("164"), /[/\\]/)).filter(Boolean));
    if (stryMutAct_9fa48("168") ? parts.length > 2 : stryMutAct_9fa48("167") ? parts.length < 2 : stryMutAct_9fa48("166") ? false : stryMutAct_9fa48("165") ? true : (stryCov_9fa48("165", "166", "167", "168"), parts.length <= 2)) return masked;
    return stryMutAct_9fa48("169") ? parts.join("/") : (stryCov_9fa48("169"), parts.slice(stryMutAct_9fa48("170") ? +2 : (stryCov_9fa48("170"), -2)).join(stryMutAct_9fa48("171") ? "" : (stryCov_9fa48("171"), "/")));
  }
}
export function maskText(text) {
  if (stryMutAct_9fa48("172")) {
    {}
  } else {
    stryCov_9fa48("172");
    if (stryMutAct_9fa48("175") ? false : stryMutAct_9fa48("174") ? true : stryMutAct_9fa48("173") ? text : (stryCov_9fa48("173", "174", "175"), !text)) return text;
    let out = redactSecrets(text);
    out = maskPath(out);
    return out;
  }
}

// ---- identity pseudonymisation ---------------------------------------------
// An account identity (the Claude OAuth email address, or the userID tier) is
// not a "secret" in the redactSecrets sense — it is the user's NAME, and none
// of the 25+ patterns above match an email. It must not land in a file
// starreckon writes, because reports, the stats page and a --join-fleet folder
// are all things people sync and share.
//
// The replacement is a pseudonym, not [redacted], because the identity is also
// a GROUPING KEY: per-account totals, the floor metric, and cross-machine fleet
// merges all break if two accounts collapse into one label. accountPseudonym is
// therefore deterministic and machine-independent — the same address yields the
// same label on every machine — and collision-resistant, unlike an initial-plus-
// domain mask ("a***@gmail.com"), which silently merges two accounts that share
// a first letter and a provider.
//
// HONEST LIMIT (printed by `starreckon verify` and stated in the README): this
// is a constant-salted SHA-256 prefix. It stops a reader of the file from
// READING your address; it does not stop someone who already suspects an
// address from CONFIRMING it by hashing their guess. It is de-identification,
// not anonymity. Raw identities are available on purpose via --show-accounts.
const PSEUDONYM_SALT = stryMutAct_9fa48("176") ? "" : (stryCov_9fa48("176"), "starreckon-account-v1:");
export function accountPseudonym(identity) {
  if (stryMutAct_9fa48("177")) {
    {}
  } else {
    stryCov_9fa48("177");
    return (stryMutAct_9fa48("178") ? "" : (stryCov_9fa48("178"), "acct-")) + (stryMutAct_9fa48("179") ? createHash("sha256").update(PSEUDONYM_SALT + String(identity ?? "")).digest("hex") : (stryCov_9fa48("179"), createHash(stryMutAct_9fa48("180") ? "" : (stryCov_9fa48("180"), "sha256")).update(stryMutAct_9fa48("181") ? PSEUDONYM_SALT - String(identity ?? "") : (stryCov_9fa48("181"), PSEUDONYM_SALT + String(stryMutAct_9fa48("182") ? identity && "" : (stryCov_9fa48("182"), identity ?? (stryMutAct_9fa48("183") ? "Stryker was here!" : (stryCov_9fa48("183"), "")))))).digest(stryMutAct_9fa48("184") ? "" : (stryCov_9fa48("184"), "hex")).slice(0, 8)));
  }
}

// ---- project pseudonymisation (--no-projects) -------------------------------
// A project label is the last two segments of a working directory, so a report
// is a legible list of what you work on: for a contractor or a bug-bounty
// hunter that is a CLIENT LIST, and it sits in a file people sync. It is kept
// readable BY DEFAULT because it is most of the report's value, and it is
// disclosed in the printed limits, the terminal, the page footer and the
// README — but a user who wants the numbers without the names needs a way to
// say so that does not depend on typing every folder into the exclusion prompt
// (which `--yes` skips entirely).
//
// Same reasoning as accountPseudonym: a stable hash, not [redacted], because
// the label is a GROUPING KEY — per-project counts must survive it.
const PROJECT_SALT = stryMutAct_9fa48("185") ? "" : (stryCov_9fa48("185"), "starreckon-project-v1:");
export function projectPseudonym(label) {
  if (stryMutAct_9fa48("186")) {
    {}
  } else {
    stryCov_9fa48("186");
    return (stryMutAct_9fa48("187") ? "" : (stryCov_9fa48("187"), "proj-")) + (stryMutAct_9fa48("188") ? createHash("sha256").update(PROJECT_SALT + String(label ?? "")).digest("hex") : (stryCov_9fa48("188"), createHash(stryMutAct_9fa48("189") ? "" : (stryCov_9fa48("189"), "sha256")).update(stryMutAct_9fa48("190") ? PROJECT_SALT - String(label ?? "") : (stryCov_9fa48("190"), PROJECT_SALT + String(stryMutAct_9fa48("191") ? label && "" : (stryCov_9fa48("191"), label ?? (stryMutAct_9fa48("192") ? "Stryker was here!" : (stryCov_9fa48("192"), "")))))).digest(stryMutAct_9fa48("193") ? "" : (stryCov_9fa48("193"), "hex")).slice(0, 8)));
  }
}

// Strings that are already anonymous: the exclusion sentinel and anything else
// bracketed by the masking layer. Hashing them would only make output harder to
// read for no gain.
const isSentinel = stryMutAct_9fa48("194") ? () => undefined : (stryCov_9fa48("194"), (() => {
  const isSentinel = s => stryMutAct_9fa48("197") ? s.startsWith("[") || s.endsWith("]") : stryMutAct_9fa48("196") ? false : stryMutAct_9fa48("195") ? true : (stryCov_9fa48("195", "196", "197"), (stryMutAct_9fa48("198") ? s.endsWith("[") : (stryCov_9fa48("198"), s.startsWith(stryMutAct_9fa48("199") ? "" : (stryCov_9fa48("199"), "[")))) && (stryMutAct_9fa48("200") ? s.startsWith("]") : (stryCov_9fa48("200"), s.endsWith(stryMutAct_9fa48("201") ? "" : (stryCov_9fa48("201"), "]")))));
  return isSentinel;
})());

// Collect every project label in a structure, then replace all of them.
//
// Two passes on purpose. Labels appear under two different shapes —
// `projects[].name` and a bare `project:` field (verified against a real
// expanded report: $.projects[].name, $.profile.projects[].name and
// $.profile.records.*.project) — and a label found under ONE shape must be
// replaced under EVERY shape, or the same project stays readable in the other
// place. Collect-then-replace makes that automatic and makes the result
// checkable: the caller can assert no collected label survives.
export function collectProjectLabels(node, out = new Set(), key = null, depth = 0) {
  if (stryMutAct_9fa48("202")) {
    {}
  } else {
    stryCov_9fa48("202");
    if (stryMutAct_9fa48("206") ? depth <= 20 : stryMutAct_9fa48("205") ? depth >= 20 : stryMutAct_9fa48("204") ? false : stryMutAct_9fa48("203") ? true : (stryCov_9fa48("203", "204", "205", "206"), depth > 20)) return out;
    if (stryMutAct_9fa48("209") ? typeof node !== "string" : stryMutAct_9fa48("208") ? false : stryMutAct_9fa48("207") ? true : (stryCov_9fa48("207", "208", "209"), typeof node === (stryMutAct_9fa48("210") ? "" : (stryCov_9fa48("210"), "string")))) {
      if (stryMutAct_9fa48("211")) {
        {}
      } else {
        stryCov_9fa48("211");
        if (stryMutAct_9fa48("214") ? key === "project" && node || !isSentinel(node) : stryMutAct_9fa48("213") ? false : stryMutAct_9fa48("212") ? true : (stryCov_9fa48("212", "213", "214"), (stryMutAct_9fa48("216") ? key === "project" || node : stryMutAct_9fa48("215") ? true : (stryCov_9fa48("215", "216"), (stryMutAct_9fa48("218") ? key !== "project" : stryMutAct_9fa48("217") ? true : (stryCov_9fa48("217", "218"), key === (stryMutAct_9fa48("219") ? "" : (stryCov_9fa48("219"), "project")))) && node)) && (stryMutAct_9fa48("220") ? isSentinel(node) : (stryCov_9fa48("220"), !isSentinel(node))))) if (stryMutAct_9fa48("221")) {
          ;
        } else {
          stryCov_9fa48("221");
          out.add(node);
        }
        return out;
      }
    }
    if (stryMutAct_9fa48("223") ? false : stryMutAct_9fa48("222") ? true : (stryCov_9fa48("222", "223"), Array.isArray(node))) {
      if (stryMutAct_9fa48("224")) {
        {}
      } else {
        stryCov_9fa48("224");
        for (const v of node) collectProjectLabels(v, out, key, stryMutAct_9fa48("226") ? depth - 1 : (stryCov_9fa48("226"), depth + 1));
        return out;
      }
    }
    if (stryMutAct_9fa48("229") ? node || typeof node === "object" : stryMutAct_9fa48("228") ? false : stryMutAct_9fa48("227") ? true : (stryCov_9fa48("227", "228", "229"), node && (stryMutAct_9fa48("231") ? typeof node !== "object" : stryMutAct_9fa48("230") ? true : (stryCov_9fa48("230", "231"), typeof node === (stryMutAct_9fa48("232") ? "" : (stryCov_9fa48("232"), "object")))))) {
      if (stryMutAct_9fa48("233")) {
        {}
      } else {
        stryCov_9fa48("233");
        for (const [k, v] of Object.entries(node)) {
          if (stryMutAct_9fa48("234")) {
            {}
          } else {
            stryCov_9fa48("234");
            // projects: [{ name, ... }] — the name IS the label
            if (stryMutAct_9fa48("237") ? k === "projects" || k === "top_projects" || Array.isArray(v) : stryMutAct_9fa48("236") ? false : stryMutAct_9fa48("235") ? true : (stryCov_9fa48("235", "236", "237"), (stryMutAct_9fa48("239") ? k === "projects" && k === "top_projects" : stryMutAct_9fa48("238") ? true : (stryCov_9fa48("238", "239"), (stryMutAct_9fa48("241") ? k !== "projects" : stryMutAct_9fa48("240") ? false : (stryCov_9fa48("240", "241"), k === (stryMutAct_9fa48("242") ? "" : (stryCov_9fa48("242"), "projects")))) || (stryMutAct_9fa48("244") ? k !== "top_projects" : stryMutAct_9fa48("243") ? false : (stryCov_9fa48("243", "244"), k === (stryMutAct_9fa48("245") ? "" : (stryCov_9fa48("245"), "top_projects")))))) && Array.isArray(v))) {
              if (stryMutAct_9fa48("246")) {
                {}
              } else {
                stryCov_9fa48("246");
                for (const item of v) if (stryMutAct_9fa48("249") ? item && typeof item.name === "string" || !isSentinel(item.name) : stryMutAct_9fa48("248") ? false : stryMutAct_9fa48("247") ? true : (stryCov_9fa48("247", "248", "249"), (stryMutAct_9fa48("251") ? item || typeof item.name === "string" : stryMutAct_9fa48("250") ? true : (stryCov_9fa48("250", "251"), item && (stryMutAct_9fa48("253") ? typeof item.name !== "string" : stryMutAct_9fa48("252") ? true : (stryCov_9fa48("252", "253"), typeof item.name === (stryMutAct_9fa48("254") ? "" : (stryCov_9fa48("254"), "string")))))) && (stryMutAct_9fa48("255") ? isSentinel(item.name) : (stryCov_9fa48("255"), !isSentinel(item.name))))) if (stryMutAct_9fa48("256")) {
                  ;
                } else {
                  stryCov_9fa48("256");
                  out.add(item.name);
                }
              }
            }
            collectProjectLabels(v, out, k, stryMutAct_9fa48("258") ? depth - 1 : (stryCov_9fa48("258"), depth + 1));
          }
        }
      }
    }
    return out;
  }
}

// Returns a COPY with every collected label replaced by its pseudonym. The
// input is never mutated: the terminal has already printed the real names by
// the time this runs, and a shared object being rewritten under it would be a
// bug waiting to happen.
export function maskProjects(node, labels = null, depth = 0) {
  if (stryMutAct_9fa48("259")) {
    {}
  } else {
    stryCov_9fa48("259");
    const set = stryMutAct_9fa48("260") ? labels && collectProjectLabels(node) : (stryCov_9fa48("260"), labels ?? collectProjectLabels(node));
    const walk = (n, d) => {
      if (stryMutAct_9fa48("261")) {
        {}
      } else {
        stryCov_9fa48("261");
        if (stryMutAct_9fa48("265") ? d <= 20 : stryMutAct_9fa48("264") ? d >= 20 : stryMutAct_9fa48("263") ? false : stryMutAct_9fa48("262") ? true : (stryCov_9fa48("262", "263", "264", "265"), d > 20)) return n;
        if (stryMutAct_9fa48("268") ? typeof n !== "string" : stryMutAct_9fa48("267") ? false : stryMutAct_9fa48("266") ? true : (stryCov_9fa48("266", "267", "268"), typeof n === (stryMutAct_9fa48("269") ? "" : (stryCov_9fa48("269"), "string")))) return set.has(n) ? projectPseudonym(n) : n;
        if (stryMutAct_9fa48("271") ? false : stryMutAct_9fa48("270") ? true : (stryCov_9fa48("270", "271"), Array.isArray(n))) return n.map(stryMutAct_9fa48("272") ? () => undefined : (stryCov_9fa48("272"), v => walk(v, stryMutAct_9fa48("273") ? d - 1 : (stryCov_9fa48("273"), d + 1))));
        if (stryMutAct_9fa48("276") ? n || typeof n === "object" : stryMutAct_9fa48("275") ? false : stryMutAct_9fa48("274") ? true : (stryCov_9fa48("274", "275", "276"), n && (stryMutAct_9fa48("278") ? typeof n !== "object" : stryMutAct_9fa48("277") ? true : (stryCov_9fa48("277", "278"), typeof n === (stryMutAct_9fa48("279") ? "" : (stryCov_9fa48("279"), "object")))))) {
          if (stryMutAct_9fa48("280")) {
            {}
          } else {
            stryCov_9fa48("280");
            const out = {};
            for (const [k, v] of Object.entries(n)) out[k] = walk(v, stryMutAct_9fa48("281") ? d - 1 : (stryCov_9fa48("281"), d + 1));
            return out;
          }
        }
        return n;
      }
    };
    return walk(node, depth);
  }
}

// Email addresses in free text. Kept as a source string (not a shared /g
// RegExp object) so no caller can be bitten by a stale lastIndex.
const EMAIL_SRC = stryMutAct_9fa48("282") ? "" : (stryCov_9fa48("282"), "[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.[A-Za-z]{2,}");
export function emailRe(flags = stryMutAct_9fa48("283") ? "" : (stryCov_9fa48("283"), "g")) {
  if (stryMutAct_9fa48("284")) {
    {}
  } else {
    stryCov_9fa48("284");
    return new RegExp(EMAIL_SRC, flags);
  }
}

// First email-shaped string in `text`, with its offset — used by the verify
// output-scrub check to point at the exact line.
export function findEmail(text) {
  if (stryMutAct_9fa48("285")) {
    {}
  } else {
    stryCov_9fa48("285");
    if (stryMutAct_9fa48("288") ? !text && typeof text !== "string" : stryMutAct_9fa48("287") ? false : stryMutAct_9fa48("286") ? true : (stryCov_9fa48("286", "287", "288"), (stryMutAct_9fa48("289") ? text : (stryCov_9fa48("289"), !text)) || (stryMutAct_9fa48("291") ? typeof text === "string" : stryMutAct_9fa48("290") ? false : (stryCov_9fa48("290", "291"), typeof text !== (stryMutAct_9fa48("292") ? "" : (stryCov_9fa48("292"), "string")))))) return null;
    const m = emailRe().exec(text);
    return m ? stryMutAct_9fa48("293") ? {} : (stryCov_9fa48("293"), {
      value: m[0],
      index: m.index
    }) : null;
  }
}

// Replace every email address in free text with its stable pseudonym.
export function maskIdentities(text) {
  if (stryMutAct_9fa48("294")) {
    {}
  } else {
    stryCov_9fa48("294");
    if (stryMutAct_9fa48("297") ? !text && typeof text !== "string" : stryMutAct_9fa48("296") ? false : stryMutAct_9fa48("295") ? true : (stryCov_9fa48("295", "296", "297"), (stryMutAct_9fa48("298") ? text : (stryCov_9fa48("298"), !text)) || (stryMutAct_9fa48("300") ? typeof text === "string" : stryMutAct_9fa48("299") ? false : (stryCov_9fa48("299", "300"), typeof text !== (stryMutAct_9fa48("301") ? "" : (stryCov_9fa48("301"), "string")))))) return text;
    return text.replace(emailRe(), stryMutAct_9fa48("302") ? () => undefined : (stryCov_9fa48("302"), m => accountPseudonym(m)));
  }
}
function escapeRe(s) {
  if (stryMutAct_9fa48("303")) {
    {}
  } else {
    stryCov_9fa48("303");
    return s.replace(stryMutAct_9fa48("304") ? /[^.*+?^${}()|[\]\\]/g : (stryCov_9fa48("304"), /[.*+?^${}()|[\]\\]/g), stryMutAct_9fa48("305") ? "" : (stryCov_9fa48("305"), "\\$&"));
  }
}