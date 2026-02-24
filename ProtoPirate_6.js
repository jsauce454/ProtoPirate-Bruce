/**
 * ProtoPirate 6 - Car Key Decoder for Bruce Firmware 1.4+
 * v3.0.0 - Full feature parity with original ProtoPirate (C/Flipper)
 *        Emulate mode: counter advance + button remapping + signal re-encoding
 *        PWM/Manchester signal encoders for protocol-aware TX
 *        KeeLoq encrypt/decrypt, TEA encrypt/decrypt, PSA XOR encrypt
 *        Auto-save decoded signals option
 *        Scrollable Protocols page
 *        Multi-line RAW_Data parsing for .sub files
 *        Pulse array size limit (memory safety)
 *        Full KAT parity: 16 protocols
 *        Pure JS crypto: TEA, KeeLoq, YEK, PSA XOR
 * Optimized for T-Embed CC1101 Plus (320x170)
 */

var display = require('display');
var keyboardApi = require('keyboard');
var subghz = require('subghz');
var storage = require('storage');

// Display API bindings
var width = display.width;
var height = display.height;
var color = display.color;
var drawFillRect = display.drawFillRect;
var drawRect = display.drawRect;
var drawString = display.drawString;
var setTextColor = display.setTextColor;
var setTextSize = display.setTextSize;
var drawLine = display.drawLine;
var drawCircle = display.drawCircle;
var drawFillCircle = display.drawFillCircle;
var drawFillTriangle = display.drawFillTriangle;
var drawFillRoundRect = display.drawFillRoundRect;
var drawRoundRect = display.drawRoundRect;

// Input bindings
var getPrevPress = keyboardApi.getPrevPress;
var getNextPress = keyboardApi.getNextPress;
var getSelPress = keyboardApi.getSelPress;
var getEscPress = keyboardApi.getEscPress;
var setLongPress = keyboardApi.setLongPress;

// Screen dimensions
var screenWidth = width();
var screenHeight = height();

// ============================================================================
// COLORS
// ============================================================================

var BLACK = color(0, 0, 0);
var WHITE = color(255, 255, 255);
var GREEN = color(0, 200, 0);
var RED = color(200, 0, 0);
var CYAN = color(0, 200, 200);
var YELLOW = color(200, 200, 0);
var GRAY = color(80, 80, 80);
var DARKGRAY = color(40, 40, 40);
var ORANGE = color(200, 100, 0);
var PURPLE = color(150, 80, 200);
var BLUE = color(60, 100, 255);
var HEADERBLUE = color(0, 40, 60);
var FOOTERBG = color(0, 30, 30);

// ============================================================================
// MENU DEFINITION
// ============================================================================

var menuIndex = 0;
var menuLabels = ["Receive", "Load SUB", "History", "Timing", "Settings", "Protocols", "Exit"];
var menuColors = [CYAN, YELLOW, GREEN, ORANGE, WHITE, BLUE, RED];

// ============================================================================
// APPLICATION STATE
// ============================================================================

var appState = "menu";
var lastResult = null;
var lastRawData = "";
var resultMenuIndex = 0;
var loadFileIndex = 0;
var loadedFiles = [];
var history = [];
var historyIndex = 0;
var saveCounter = 0;
var previousState = "receive";
var HISTORY_MAX = 20;
var infoScrollIndex = 0;

// Emulate state
var emulateCounter = 0;
var emulateOrigCounter = 0;
var emulateButton = 0;
var emulateSerial = 0;
var emulateProto = "";
var emulateDataHi = 0;
var emulateDataLo = 0;
var emulateBitCount = 0;
var emulateEncrypted = false;
var emulateBtnIndex = 0;
var emulateBtnList = [];
// PSA emulate state
var emulatePsaMode = 0;
var emulatePsaCrc = 0;
var emulatePsaBuf9 = null;
// VAG T2 emulate state
var emulateVagTypeByte = 0;
var emulateVagDispatch = 0;

// File Manager state
var fmCurrentDir = "/BruceRF/";
var fmEntries = [];      // [{name, isDir, fullPath, displayName}]
var fmIndex = 0;
var fmDirStack = [];     // stack of {dir, index} for back navigation
var FM_START_DIR = "/BruceRF/";

// ============================================================================
// SETTINGS
// ============================================================================

var settingsIndex = 0;

// Frequency
var frequency = 433.92;
var freqOptions = [315.0, 433.92, 868.35];
var freqIndex = 1;
var freqLabels = ["315.00 MHz (US)", "433.92 MHz (EU)", "868.35 MHz (EU)"];

// Sensitivity: minimum pulse count to consider a valid signal
var sensOptions = [5, 10, 20, 30];
var sensIndex = 1;
var sensLabels = ["Ultra (5)", "Sensitive (10)", "Normal (20)", "Strict (30)"];

// Max pulse duration filter (us) - sync/gap pulses above this are removed
var filterOptions = [5000, 50000, 100000, 500000];
var filterIndex = 2;
var filterLabels = ["5ms", "50ms", "100ms", "500ms"];

// TX burst count
var txBurstOptions = [1, 3, 5, 10];
var txBurstIndex = 1;
var txBurstLabels = ["1x", "3x", "5x", "10x"];

// Preset
var presetName = "AM650";

// Auto-save decoded signals
var autoSave = false;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function abs(x) { return x < 0 ? -x : x; }
function durMatch(dur, target, delta) { return abs(dur - target) < delta; }

function toHex(n, d) {
    var h = n.toString(16).toUpperCase();
    while (h.length < d) h = "0" + h;
    return h;
}

function clearScreen() { drawFillRect(0, 0, screenWidth, screenHeight, BLACK); }

// Reverse all 64 bits of a hi/lo pair (for StarLine, Kia V3/V4 KeeLoq)
function reverseKey64(hi, lo) {
    var rhi = 0, rlo = 0;
    for (var i = 0; i < 32; i++) {
        if ((lo >>> i) & 1) rhi |= (1 << (31 - i));
        if ((hi >>> i) & 1) rlo |= (1 << (31 - i));
    }
    return { hi: rhi >>> 0, lo: rlo >>> 0 };
}

// ============================================================================
// CRYPTO PRIMITIVES (pure JS - TEA, mixer, YEK)
// ============================================================================

// Standard TEA decrypt (32 rounds). key = [k0,k1,k2,k3] as 32-bit ints.
function teaDecrypt(v0, v1, key) {
    var delta = 0x9E3779B9;
    var sum = Math.imul(delta, 32) >>> 0;
    for (var i = 0; i < 32; i++) {
        v1 = (v1 - ((((v0 << 4) + key[2]) ^ (v0 + sum) ^ ((v0 >>> 5) + key[3])))) >>> 0;
        v0 = (v0 - ((((v1 << 4) + key[0]) ^ (v1 + sum) ^ ((v1 >>> 5) + key[1])))) >>> 0;
        sum = (sum - delta) >>> 0;
    }
    return { v0: v0 >>> 0, v1: v1 >>> 0 };
}

// VAG variant TEA decrypt: uses key[(sum>>11)&3] and key[sum&3] indexing.
function vagTeaDecrypt(v0, v1, key) {
    var delta = 0x9E3779B9;
    var sum = Math.imul(delta, 32) >>> 0;
    for (var i = 0; i < 32; i++) {
        v1 = (v1 - ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + key[((sum >>> 11) & 3)]))) >>> 0;
        sum = (sum - delta) >>> 0;
        v0 = (v0 - ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + key[(sum & 3)]))) >>> 0;
    }
    return { v0: v0 >>> 0, v1: v1 >>> 0 };
}

// PSA XOR decrypt (matches psa.c psa_second_stage_xor_decrypt with psa_copy_reverse).
// Transposition: tmp = [buf[5],buf[4],buf[3],buf[2],buf[9],buf[8],buf[7],buf[6]]
// Then XOR: buf[i] = tmp[a] ^ tmp[b] per the C reference.
function psaXorDecrypt(buf) {
    var e2 = buf[2], e3 = buf[3], e4 = buf[4], e5 = buf[5], e6 = buf[6], e7 = buf[7];
    var e8 = buf[8], e9 = buf[9];
    buf[2] = (e5 ^ e7) & 0xFF;
    buf[3] = (e3 ^ e5) & 0xFF;
    buf[4] = (e7 ^ e2) & 0xFF;
    buf[5] = (e6 ^ e4) & 0xFF;
    buf[6] = (e2 ^ e4) & 0xFF;
    buf[7] = (e7 ^ e9 ^ e8) & 0xFF;
}

// YEK: reverse bit order per byte of a 64-bit value (hi/lo).
function computeYEK(hi, lo) {
    var yek_hi = 0, yek_lo = 0;
    for (var byteIdx = 0; byteIdx < 8; byteIdx++) {
        var srcByte = (byteIdx < 4) ? ((lo >>> (byteIdx * 8)) & 0xFF) : ((hi >>> ((byteIdx - 4) * 8)) & 0xFF);
        var rev = 0;
        for (var b = 0; b < 8; b++) { if (srcByte & (1 << b)) rev |= (1 << (7 - b)); }
        var dstByteIdx = 7 - byteIdx;
        if (dstByteIdx < 4) { yek_lo |= (rev << (dstByteIdx * 8)); }
        else { yek_hi |= (rev << ((dstByteIdx - 4) * 8)); }
    }
    return { hi: yek_hi >>> 0, lo: yek_lo >>> 0 };
}

// Standard TEA encrypt (32 rounds). key = [k0,k1,k2,k3] as 32-bit ints.
function teaEncrypt(v0, v1, key) {
    var delta = 0x9E3779B9;
    var sum = 0;
    for (var i = 0; i < 32; i++) {
        sum = (sum + delta) >>> 0;
        v0 = (v0 + ((((v1 << 4) + key[0]) ^ (v1 + sum) ^ ((v1 >>> 5) + key[1])))) >>> 0;
        v1 = (v1 + ((((v0 << 4) + key[2]) ^ (v0 + sum) ^ ((v0 >>> 5) + key[3])))) >>> 0;
    }
    return { v0: v0 >>> 0, v1: v1 >>> 0 };
}

// VAG variant TEA encrypt: uses key[sum&3] and key[(sum>>11)&3] indexing.
function vagTeaEncrypt(v0, v1, key) {
    var delta = 0x9E3779B9;
    var sum = 0;
    for (var i = 0; i < 32; i++) {
        v0 = (v0 + ((((v1 << 4) ^ (v1 >>> 5)) + v1) ^ (sum + key[(sum & 3)]))) >>> 0;
        sum = (sum + delta) >>> 0;
        v1 = (v1 + ((((v0 << 4) ^ (v0 >>> 5)) + v0) ^ (sum + key[((sum >>> 11) & 3)]))) >>> 0;
    }
    return { v0: v0 >>> 0, v1: v1 >>> 0 };
}

// KeeLoq encrypt (528 rounds). key = {hi, lo} as two 32-bit ints.
// Input: 0xBSSSCCCC (B=btn4, S=serial10, C=counter16)
// NLF = 0x3A5C742E
function keeloqEncrypt(data, keyHi, keyLo) {
    var NLF = 0x3A5C742E;
    var x = data >>> 0;
    for (var r = 0; r < 528; r++) {
        var keyBit = (r & 32) ? ((keyHi >>> (r & 31)) & 1) : ((keyLo >>> (r & 31)) & 1);
        var nlf_idx = ((x >>> 1) & 1) + (((x >>> 9) & 1) << 1) + (((x >>> 20) & 1) << 2) +
                      (((x >>> 26) & 1) << 3) + (((x >>> 31) & 1) << 4);
        var nlf_bit = (NLF >>> nlf_idx) & 1;
        var feedback = ((x & 1) ^ ((x >>> 16) & 1) ^ keyBit ^ nlf_bit);
        x = ((x >>> 1) | (feedback << 31)) >>> 0;
    }
    return x >>> 0;
}

// KeeLoq decrypt (528 rounds).
function keeloqDecrypt(data, keyHi, keyLo) {
    var NLF = 0x3A5C742E;
    var x = data >>> 0;
    for (var r = 0; r < 528; r++) {
        var keyBit = ((15 - r) & 32) ? ((keyHi >>> ((15 - r) & 31)) & 1) : ((keyLo >>> ((15 - r) & 31)) & 1);
        var nlf_idx = ((x >>> 0) & 1) + (((x >>> 8) & 1) << 1) + (((x >>> 19) & 1) << 2) +
                      (((x >>> 25) & 1) << 3) + (((x >>> 30) & 1) << 4);
        var nlf_bit = (NLF >>> nlf_idx) & 1;
        var feedback = ((x >>> 31) & 1) ^ ((x >>> 15) & 1) ^ keyBit ^ nlf_bit;
        x = (((x << 1) & 0xFFFFFFFE) | feedback) >>> 0;
    }
    return x >>> 0;
}

// KeeLoq Normal Learning: derive device key from serial + manufacturer key
function keeloqNormalLearning(serial, mfKeyHi, mfKeyLo) {
    var data = (serial & 0x0FFFFFFF) | 0x20000000;
    var k1 = keeloqDecrypt(data, mfKeyHi, mfKeyLo);
    data = (serial & 0x0FFFFFFF) | 0x60000000;
    var k2 = keeloqDecrypt(data, mfKeyHi, mfKeyLo);
    return { hi: k2 >>> 0, lo: k1 >>> 0 };
}

// PSA XOR encrypt (matches psa.c psa_second_stage_xor_encrypt - inverse of decrypt).
// Operates in-place on buf[2..7], uses buf[8..9] as validation input.
function psaXorEncrypt(buf) {
    var p2 = buf[2], p3 = buf[3], p4 = buf[4], p5 = buf[5], p6 = buf[6], p7 = buf[7];
    buf[7] = (p7 ^ buf[9] ^ buf[8]) & 0xFF;
    buf[2] = (p4 ^ buf[7]) & 0xFF;
    buf[4] = (p6 ^ buf[2]) & 0xFF;
    buf[6] = (p5 ^ buf[4]) & 0xFF;
    buf[5] = (p2 ^ buf[7]) & 0xFF;
    buf[3] = (p3 ^ buf[5]) & 0xFF;
}

function drawMessage(msg, col) {
    clearScreen();
    setTextSize(1); setTextColor(col);
    var lines = msg.split("\n");
    var totalH = lines.length * 14;
    var y = Math.floor((screenHeight - totalH) / 2);
    for (var i = 0; i < lines.length; i++) {
        var charW = 6;
        var textW = lines[i].length * charW;
        var x = Math.max(10, Math.floor((screenWidth - textW) / 2));
        drawString(lines[i], x, y + i * 14);
    }
}

// ============================================================================
// CRC FUNCTIONS
// ============================================================================

function kiaCrc8(bytes) {
    var crc = 0;
    for (var i = 0; i < bytes.length; i++) {
        crc = crc ^ bytes[i];
        for (var j = 0; j < 8; j++) {
            if ((crc & 0x80) !== 0) { crc = ((crc << 1) ^ 0x7F) & 0xFF; }
            else { crc = (crc << 1) & 0xFF; }
        }
    }
    return crc;
}

function kiaV1Crc4(bytes, count, offset) {
    var crc = 0;
    for (var i = 0; i < count; i++) { crc = crc ^ ((bytes[i] & 0x0F) ^ (bytes[i] >>> 4)); }
    crc = (crc + offset) & 0x0F;
    return crc;
}

function kiaV2CalcCrc(dataHi, dataLo) {
    var wHi = (dataHi >>> 4) | 0;
    var wLo = ((dataLo >>> 4) | (dataHi << 28)) >>> 0;
    var bytes = [];
    bytes[0] = wLo & 0xFF; bytes[1] = (wLo >>> 8) & 0xFF;
    bytes[2] = (wLo >>> 16) & 0xFF; bytes[3] = (wLo >>> 24) & 0xFF;
    bytes[4] = wHi & 0xFF; bytes[5] = (wHi >>> 8) & 0xFF;
    var crc = 0;
    for (var i = 0; i < 6; i++) { crc = crc ^ ((bytes[i] & 0x0F) ^ (bytes[i] >>> 4)); }
    return (crc + 1) & 0x0F;
}

var FORD_CRC_MATRIX = [
    0xDA, 0xB5, 0x55, 0x6A, 0xAA, 0xAA, 0xAA, 0xD5,
    0xB6, 0x6C, 0xCC, 0xD9, 0x99, 0x99, 0x99, 0xB3,
    0x71, 0xE3, 0xC3, 0xC7, 0x87, 0x87, 0x87, 0x8F,
    0x0F, 0xE0, 0x3F, 0xC0, 0x7F, 0x80, 0x7F, 0x80,
    0x00, 0x1F, 0xFF, 0xC0, 0x00, 0x7F, 0xFF, 0x80,
    0x00, 0x00, 0x00, 0x3F, 0xFF, 0xFF, 0xFF, 0x80,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7F,
    0x23, 0x12, 0x94, 0x84, 0x35, 0xF4, 0x55, 0x84
];

function popcount8(x) { var c = 0; while (x) { c += x & 1; x >>>= 1; } return c; }

function fordCalcCrc(buf) {
    var crc = 0;
    for (var row = 0; row < 8; row++) {
        var xorSum = 0;
        for (var col = 0; col < 8; col++) { xorSum ^= (FORD_CRC_MATRIX[row * 8 + col] & buf[col + 1]); }
        if (popcount8(xorSum) & 1) { crc |= (1 << row); }
    }
    return crc;
}

// PSA checksum (matches psa.c psa_calculate_checksum)
// Sum of all nibbles in buf[2..7], multiply by 16
function psaChecksum(buf) {
    var sum = 0;
    for (var i = 2; i < 8; i++) {
        sum += (buf[i] & 0x0F) + ((buf[i] >>> 4) & 0x0F);
    }
    return (sum * 16) & 0xFF;
}

// ============================================================================
// BUTTON NAME LOOKUP
// ============================================================================

function getButtonName(proto, btn) {
    if (proto.indexOf("Kia") >= 0) {
        if (proto.indexOf("V1") >= 0) {
            if (btn === 1) return "Close"; if (btn === 2) return "Open"; if (btn === 3) return "Boot";
        } else {
            if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
            if (btn === 3) return "Trunk"; if (btn === 4) return "Panic";
        }
    } else if (proto.indexOf("Ford") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock"; if (btn === 4) return "Boot";
    } else if (proto.indexOf("Suzuki") >= 0) {
        if (btn === 1) return "Panic"; if (btn === 2) return "Boot";
        if (btn === 3) return "Lock"; if (btn === 4) return "Unlock";
    } else if (proto.indexOf("Subaru") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
        if (btn === 3) return "Boot"; if (btn === 4) return "Panic"; if (btn === 8) return "Panic";
    } else if (proto.indexOf("Fiat") >= 0) {
        if (btn === 1) return "Unlock"; if (btn === 2) return "Lock"; if (btn === 4) return "Boot";
    } else if (proto.indexOf("Chrysler") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
        if (btn === 4) return "Trunk"; if (btn === 8) return "Panic";
    } else if (proto.indexOf("StarLine") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
        if (btn === 3) return "Boot"; if (btn === 4) return "Panic";
    } else if (proto.indexOf("PSA") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
        if (btn === 4) return "Boot"; if (btn === 8) return "Open";
    } else if (proto.indexOf("VAG") >= 0) {
        if (btn === 1 || btn === 0x10) return "Unlock";
        if (btn === 2 || btn === 0x20) return "Lock";
        if (btn === 4 || btn === 0x40) return "Boot";
    } else if (proto.indexOf("V5") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
        if (btn === 3) return "Trunk"; if (btn === 4) return "Panic";
    } else if (proto.indexOf("V6") >= 0) {
        if (btn === 1) return "Lock"; if (btn === 2) return "Unlock";
        if (btn === 4) return "Trunk"; if (btn === 8) return "Panic";
    }
    return "Btn:" + toHex(btn, 2);
}

// ============================================================================
// HISTORY MANAGEMENT
// ============================================================================

function historyAdd(result, rawData) {
    if (history.length >= HISTORY_MAX) { history.shift(); }
    history.push({ result: result, rawData: rawData, frequency: frequency, preset: presetName });
    return true;
}

function historyGetTextItem(idx) {
    if (idx >= history.length) return "---";
    var item = history[idx];
    return (idx + 1) + ". " + item.result.proto + " " + item.result.btnName;
}

function historyGetFullItem(idx) {
    if (idx >= history.length) return "---";
    var item = history[idx];
    var r = item.result;
    var text = "Protocol: " + r.proto + "\nBits: " + r.bits + "\nSerial: " + toHex(r.serial, 7);
    text += "\nButton: " + r.btnName + "\nCounter: 0x" + toHex(r.counter, 4);
    text += "\nCRC: " + (r.crcOk ? "OK" : "FAIL") + "\nFreq: " + item.frequency + " MHz";
    return text;
}

// ============================================================================
// PROTOCOL CONSTANTS
// ============================================================================

var PROTO_KIA_V0 = { name: "Kia V0", te_short: 250, te_long: 500, te_delta: 100, min_bits: 61 };
var PROTO_KIA_V1 = { name: "Kia V1", te_short: 800, te_long: 1600, te_delta: 200, min_bits: 57 };
var PROTO_KIA_V2 = { name: "Kia V2", te_short: 500, te_long: 1000, te_delta: 150, min_bits: 53 };
var PROTO_FORD = { name: "Ford V0", te_short: 250, te_long: 500, te_delta: 120, min_bits: 64 };
var PROTO_SUZUKI = { name: "Suzuki", te_short: 250, te_long: 500, te_delta: 99, min_bits: 64 };
var PROTO_STARLINE = { name: "StarLine", te_short: 250, te_long: 500, te_delta: 120, min_bits: 64 };
var PROTO_SCHERKHAN = { name: "Scher-Khan", te_short: 750, te_long: 1100, te_delta: 160, min_bits: 35 };
var PROTO_SUBARU = { name: "Subaru", te_short: 800, te_long: 1600, te_delta: 200, min_bits: 64 };
var PROTO_FIAT = { name: "Fiat V0", te_short: 200, te_long: 400, te_delta: 100, min_bits: 64 };
var PROTO_CHRYSLER = { name: "Chrysler", te_short: 200, te_long: 400, te_delta: 120, min_bits: 64 };
var PROTO_KIA_V3V4 = { name: "Kia V3/V4", te_short: 400, te_long: 800, te_delta: 150, min_bits: 64 };
var PROTO_KIA_V5 = { name: "Kia V5", te_short: 400, te_long: 800, te_delta: 150, min_bits: 64 };
var PROTO_KIA_V6 = { name: "Kia V6", te_short: 200, te_long: 400, te_delta: 100, min_bits: 144 };
var PROTO_PSA = { name: "PSA", te_short: 250, te_long: 500, te_delta: 100, min_bits: 96 };
var PROTO_VAG12 = { name: "VAG T1/T2", te_short: 300, te_long: 600, te_delta: 100, min_bits: 80 };
var PROTO_VAG34 = { name: "VAG T3/T4", te_short: 500, te_long: 1000, te_delta: 120, min_bits: 80 };

// PSA TEA key schedules (fixed, from KAT reference)
var PSA_BF1_KEY = [0x4A434915, 0xD6743C2B, 0x1F29D308, 0xE6B79A64];
var PSA_BF2_KEY = [0x4039C240, 0xEDA92CAB, 0x4306C02A, 0x02192A04];
// VAG TEA key schedule
var VAG_TEA_KEY = [0x0B46502D, 0x5E253718, 0x2BF93A19, 0x622C1206];

// ============================================================================
// SIGNAL ENCODERS (generate RAW_Data for .sub files)
// ============================================================================

// Encode data as PWM signal → RAW_Data string
// PWM: bit 0 = short-high + short-low, bit 1 = long-high + long-low
function encodePWM(dataHi, dataLo, dataBits, teShort, teLong, preamblePairs, burstCount, burstGap) {
    var rawParts = [];
    for (var burst = 0; burst < burstCount; burst++) {
        if (burst > 0) rawParts.push(-burstGap);
        // Preamble: alternating short-high, short-low pairs
        for (var p = 0; p < preamblePairs; p++) {
            rawParts.push(teShort);
            rawParts.push(-teShort);
        }
        // Start bit: long-high + long-low
        rawParts.push(teLong);
        rawParts.push(-teLong);
        // Data bits MSB first (dataBits excluding the start bit)
        var bitsToSend = dataBits - 2; // -1 start bit, -1 for 0-indexing
        for (var bn = 0; bn <= bitsToSend; bn++) {
            var bitPos = bitsToSend - bn;
            var bit;
            if (bitPos >= 32) bit = (dataHi >>> (bitPos - 32)) & 1;
            else bit = (dataLo >>> bitPos) & 1;
            var dur = bit ? teLong : teShort;
            rawParts.push(dur);
            rawParts.push(-dur);
        }
        // End marker
        rawParts.push(teLong * 2);
    }
    return rawParts.join(" ");
}

// Encode data as Manchester signal → RAW_Data string
// bit 1 = high-then-low, bit 0 = low-then-high
function encodeManchester(dataHi, dataLo, dataBits, teShort, preamblePairs, burstCount, burstGap) {
    var teLong = teShort * 2;
    var levels = []; // [{lv: bool, dur: int}]
    for (var burst = 0; burst < burstCount; burst++) {
        if (burst > 0) levels.push({lv: false, dur: burstGap});
        // Preamble: alternating long-high, long-low pairs
        for (var p = 0; p < preamblePairs; p++) {
            levels.push({lv: true, dur: teLong});
            levels.push({lv: false, dur: teLong});
        }
        // Start: long-high, short-low (start bit = 1)
        levels.push({lv: true, dur: teLong});
        levels.push({lv: false, dur: teShort});
        // Data bits MSB first (skip the leading 1 start bit)
        var bitsToSend = dataBits - 2;
        for (var bn = 0; bn <= bitsToSend; bn++) {
            var bitPos = bitsToSend - bn;
            var bit;
            if (bitPos >= 32) bit = (dataHi >>> (bitPos - 32)) & 1;
            else bit = (dataLo >>> bitPos) & 1;
            if (bit) {
                levels.push({lv: true, dur: teShort});
                levels.push({lv: false, dur: teShort});
            } else {
                levels.push({lv: false, dur: teShort});
                levels.push({lv: true, dur: teShort});
            }
        }
        // End gap
        levels.push({lv: false, dur: teLong * 4});
    }
    // Coalesce adjacent same-level durations
    var raw = [];
    var cur = levels[0];
    for (var i = 1; i < levels.length; i++) {
        if (levels[i].lv === cur.lv) { cur = {lv: cur.lv, dur: cur.dur + levels[i].dur}; }
        else { raw.push(cur.lv ? cur.dur : -cur.dur); cur = levels[i]; }
    }
    raw.push(cur.lv ? cur.dur : -cur.dur);
    return raw.join(" ");
}

// ============================================================================
// PROTOCOL REBUILDERS (reconstruct data with new button/counter + CRC)
// ============================================================================

function rebuildKiaV0(serial, button, counter) {
    var flags = 0x0F;
    var hi = ((flags & 0x0F) << 24) | ((counter & 0xFFFF) << 8) | ((serial >>> 20) & 0xFF);
    var lo = ((serial & 0xFFFFF) << 12) | ((button & 0x0F) << 8);
    var crcBytes = [(hi >>> 16) & 0xFF, (hi >>> 8) & 0xFF, hi & 0xFF,
                    (lo >>> 24) & 0xFF, (lo >>> 16) & 0xFF, (lo >>> 8) & 0xFF];
    lo = (lo | kiaCrc8(crcBytes)) >>> 0;
    return { dataHi: hi >>> 0, dataLo: lo, bits: 61, enc: "pwm",
             teS: 250, teL: 500, preamble: 16, bursts: 2, gap: 25000 };
}

function rebuildKiaV1(serial, button, counter) {
    var cntLo = counter & 0xFF;
    var cntHi = (counter >>> 8) & 0x0F;
    var hi = (serial >>> 8) >>> 0;
    var lo = ((serial & 0xFF) << 24) | ((button & 0xFF) << 16) | (cntLo << 8) | (cntHi << 4);
    var charData = [(serial >>> 24) & 0xFF, (serial >>> 16) & 0xFF,
                    (serial >>> 8) & 0xFF, serial & 0xFF, button, cntLo];
    var offset;
    if (cntHi === 0) { offset = (counter >= 0x98) ? button : 1; }
    else if (cntHi >= 0x6) { charData[6] = cntHi; offset = 1; }
    else { offset = 1; }
    var crc = kiaV1Crc4(charData, charData.length, offset);
    lo = (lo | (crc & 0x0F)) >>> 0;
    return { dataHi: hi >>> 0, dataLo: lo, bits: 57, enc: "manchester",
             teS: 800, preamble: 36, bursts: 2, gap: 30000 };
}

function rebuildKiaV2(serial, button, counter) {
    var rawCount = ((counter & 0xFF) << 4) | ((counter >>> 8) & 0x0F);
    var hi = (serial >>> 12) >>> 0;
    var lo = ((serial & 0xFFF) << 20) | ((button & 0x0F) << 16) | ((rawCount & 0xFFF) << 4);
    // Compute CRC4
    var wHi = (hi >>> 4) | 0;
    var wLo = ((lo >>> 4) | (hi << 28)) >>> 0;
    var bytes = [wLo & 0xFF, (wLo >>> 8) & 0xFF, (wLo >>> 16) & 0xFF,
                 (wLo >>> 24) & 0xFF, wHi & 0xFF, (wHi >>> 8) & 0xFF];
    var crc = 0;
    for (var i = 0; i < 6; i++) { crc = crc ^ ((bytes[i] & 0x0F) ^ (bytes[i] >>> 4)); }
    crc = (crc + 1) & 0x0F;
    lo = (lo | crc) >>> 0;
    return { dataHi: hi >>> 0, dataLo: lo, bits: 53, enc: "manchester",
             teS: 500, preamble: 50, bursts: 2, gap: 30000 };
}

function rebuildFordV0(serial, button, counter) {
    // Ford: 80 bits = 10 bytes, Manchester
    // Byte layout: [fixed][serial3B][btn1B][cnt2B][padding][crc]
    var buf = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    buf[0] = 0xF0; // fixed header nibble
    buf[1] = (serial >>> 16) & 0xFF;
    buf[2] = (serial >>> 8) & 0xFF;
    buf[3] = serial & 0xFF;
    buf[4] = button & 0xFF;
    buf[5] = (counter >>> 8) & 0xFF;
    buf[6] = counter & 0xFF;
    buf[7] = 0; buf[8] = 0;
    buf[9] = fordCalcCrc(buf);
    // Pack as dataHi (32b) + dataLo (32b) + extra
    var hi = (buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3];
    var lo = (buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7];
    return { dataHi: hi >>> 0, dataLo: lo, extraHi: ((buf[8] << 8) | buf[9]) >>> 0,
             bits: 80, enc: "manchester",
             teS: 250, preamble: 20, bursts: 2, gap: 25000 };
}

function rebuildSubaru(serial, button, counter) {
    var hi = ((serial >>> 8) & 0x00FFFFFF) | ((button & 0xFF) << 24);
    var lo = ((serial & 0xFF) << 24) | ((counter & 0xFFFF) << 8);
    return { dataHi: hi >>> 0, dataLo: lo >>> 0, bits: 64, enc: "pwm",
             teS: 800, teL: 1600, preamble: 8, bursts: 2, gap: 30000 };
}

function rebuildSuzuki(serial, button) {
    var hi = ((serial >>> 8) & 0x00FFFFFF) | ((button & 0xFF) << 24);
    var lo = ((serial & 0xFF) << 24);
    return { dataHi: hi >>> 0, dataLo: lo >>> 0, bits: 64, enc: "pwm",
             teS: 250, teL: 500, preamble: 16, bursts: 2, gap: 25000 };
}

function rebuildChrysler(serial, button, counter) {
    var hi = ((button & 0xFF) << 24) | ((serial >>> 8) & 0x00FFFFFF);
    var lo = ((serial & 0xFF) << 24) | ((counter & 0xFFFF) << 8);
    return { dataHi: hi >>> 0, dataLo: lo >>> 0, bits: 64, enc: "pwm",
             teS: 200, teL: 400, preamble: 16, bursts: 2, gap: 25000 };
}

// PSA mode 0x23 rebuilder (matches psa.c psa_build_buffer_mode23)
// psaBuf1: preserved buffer[1], psaCrc: buf[7] (crc byte), psaBuf9: preserved buffer[9]
function rebuildPSA(serial, button, counter, psaCrc, psaBuf9) {
    var buf = [0x23, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    // Pack plaintext into buffer[2-8]
    buf[2] = (serial >>> 16) & 0xFF;
    buf[3] = (serial >>> 8) & 0xFF;
    buf[4] = serial & 0xFF;
    buf[5] = (counter >>> 8) & 0xFF;
    buf[6] = counter & 0xFF;
    buf[7] = psaCrc & 0xFF;
    var initialButton = button & 0x0F;

    // Brute force: find valid buffer[8] top nibble (and optionally buffer[9])
    var hasOrigKey2 = (psaBuf9 !== undefined && psaBuf9 !== null);
    var buf9Start = hasOrigKey2 ? psaBuf9 : 0;
    var buf9End = hasOrigKey2 ? psaBuf9 + 1 : 256;
    var found = false;
    var plaintext = [buf[2], buf[3], buf[4], buf[5], buf[6], buf[7]];

    for (var buf9Try = buf9Start; buf9Try < buf9End && !found; buf9Try++) {
        for (var buf8Hi = 0; buf8Hi < 16 && !found; buf8Hi++) {
            // Restore plaintext each iteration
            buf[2] = plaintext[0]; buf[3] = plaintext[1]; buf[4] = plaintext[2];
            buf[5] = plaintext[3]; buf[6] = plaintext[4]; buf[7] = plaintext[5];
            buf[8] = initialButton | (buf8Hi << 4);
            buf[9] = buf9Try & 0xFF;

            // XOR encrypt
            psaXorEncrypt(buf);

            // Compute checksum over encrypted buf[2..7]
            var checksum = psaChecksum(buf);
            var validation = (checksum ^ buf[8]) & 0xF0;
            if (validation === 0) {
                buf[8] = (buf[8] & 0x0F) | (checksum & 0xF0);
                found = true;
            }
        }
    }

    if (!found) {
        // Fallback: encrypt with defaults
        buf[2] = plaintext[0]; buf[3] = plaintext[1]; buf[4] = plaintext[2];
        buf[5] = plaintext[3]; buf[6] = plaintext[4]; buf[7] = plaintext[5];
        buf[8] = initialButton;
        buf[9] = hasOrigKey2 ? psaBuf9 : 0x23;
        psaXorEncrypt(buf);
    }

    // Derive buffer[1] from encrypted bytes (matches C fallback)
    buf[1] = (buf[3] ^ buf[7]) & 0xFF;
    // Derive buffer[0] = 0x23 (seed byte, already set)

    // Pack into key1Hi/key1Lo/valField
    var key1Hi = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
    var key1Lo = ((buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7]) >>> 0;
    var valField = ((buf[8] << 8) | buf[9]) & 0xFFFF;

    return { dataHi: key1Hi, dataLo: key1Lo, valField: valField, bits: 96, enc: "psa_manchester" };
}

// VAG T2 TEA rebuilder (matches vag.c vag_encoder_build_type2)
function rebuildVAGT2(serial, button, counter, vagTypeByte, vagDispatch) {
    // Transform button value for TEA type (1→0x10, 2→0x20, 4→0x40)
    var btnByte = button;
    if (button === 1) btnByte = 0x10;
    else if (button === 2) btnByte = 0x20;
    else if (button === 4) btnByte = 0x40;

    // Compute dispatch byte from button
    var dispatch = vagDispatch;
    if (dispatch === undefined || dispatch === null) {
        if (btnByte === 0x20 || btnByte === 2) dispatch = 0x2A;
        else if (btnByte === 0x40 || btnByte === 4) dispatch = 0x46;
        else if (btnByte === 0x10 || btnByte === 1) dispatch = 0x1C;
        else dispatch = 0x2A;
    }

    // Build plaintext: serial(4B BE) + counter(3B LE) + btn(1B)
    var v0 = serial >>> 0;
    var v1 = (((counter & 0xFF) << 24) | (((counter >>> 8) & 0xFF) << 16) |
              (((counter >>> 16) & 0xFF) << 8) | (btnByte & 0xFF)) >>> 0;

    // TEA encrypt
    var tea = vagTeaEncrypt(v0, v1, VAG_TEA_KEY);

    // Unpack encrypted result to 8 bytes
    var block = [
        (tea.v0 >>> 24) & 0xFF, (tea.v0 >>> 16) & 0xFF, (tea.v0 >>> 8) & 0xFF, tea.v0 & 0xFF,
        (tea.v1 >>> 24) & 0xFF, (tea.v1 >>> 16) & 0xFF, (tea.v1 >>> 8) & 0xFF, tea.v1 & 0xFF
    ];

    // Pack into key1/key2 with type_byte
    var typeByte = vagTypeByte || 0;
    var key1Hi = ((typeByte << 24) | (block[0] << 16) | (block[1] << 8) | block[2]) >>> 0;
    var key1Lo = ((block[3] << 24) | (block[4] << 16) | (block[5] << 8) | block[6]) >>> 0;
    var key2 = ((block[7] << 8) | (dispatch & 0xFF)) & 0xFFFF;

    return { dataHi: key1Hi, dataLo: key1Lo, key2: key2, bits: 80, enc: "vag_manchester" };
}

// PSA Manchester encoder: 80-pair preamble @250µs, transition, 64b key1, 16b key2, end @1000µs
function encodePSAManchester(key1Hi, key1Lo, valField, burstCount) {
    var te = 250;
    var teLong = 500;
    var raw = [];
    for (var burst = 0; burst < burstCount; burst++) {
        if (burst > 0) raw.push(-10000); // inter-burst gap

        // Preamble: 80 pairs of 250µs high/low
        for (var p = 0; p < 80; p++) {
            raw.push(te);
            raw.push(-te);
        }

        // Transition: LOW 250µs + HIGH 500µs + LOW 250µs
        raw.push(-te);
        raw.push(teLong);
        raw.push(-te);

        // Key1: 64 bits Manchester encoded MSB first
        // bit=1: HIGH te + LOW te, bit=0: LOW te + HIGH te
        for (var b = 63; b >= 0; b--) {
            var bit;
            if (b >= 32) bit = (key1Hi >>> (b - 32)) & 1;
            else bit = (key1Lo >>> b) & 1;
            if (bit) { raw.push(te); raw.push(-te); }
            else { raw.push(-te); raw.push(te); }
        }

        // Key2 (valField): 16 bits Manchester encoded MSB first
        for (var b2 = 15; b2 >= 0; b2--) {
            var bit2 = (valField >>> b2) & 1;
            if (bit2) { raw.push(te); raw.push(-te); }
            else { raw.push(-te); raw.push(te); }
        }

        // End marker: 1000µs high + 1000µs low
        raw.push(1000);
        raw.push(-1000);
    }
    // Coalesce adjacent same-sign values
    return coalesceRaw(raw);
}

// VAG T2 Manchester encoder: 220-pair preamble @300µs, prefix 0xAF1C, key1 inverted, key2 inverted
function encodeVAGT2Manchester(key1Hi, key1Lo, key2, burstCount) {
    var te = 300;
    var raw = [];
    for (var burst = 0; burst < burstCount; burst++) {
        if (burst > 0) raw.push(-10000); // inter-burst gap

        // Preamble: 220 pairs of 300µs high/low
        for (var p = 0; p < 220; p++) {
            raw.push(te);
            raw.push(-te);
        }
        // Sync: LOW 300µs + HIGH 300µs
        raw.push(-te);
        raw.push(te);

        // Prefix 0xAF1C: 16 bits Manchester MSB first (NOT inverted)
        var prefix = 0xAF1C;
        for (var b = 15; b >= 0; b--) {
            var bit = (prefix >>> b) & 1;
            if (bit) { raw.push(te); raw.push(-te); }
            else { raw.push(-te); raw.push(te); }
        }

        // Key1: 64 bits INVERTED, Manchester MSB first
        var invHi = (~key1Hi) >>> 0;
        var invLo = (~key1Lo) >>> 0;
        for (var b2 = 63; b2 >= 0; b2--) {
            var bit2;
            if (b2 >= 32) bit2 = (invHi >>> (b2 - 32)) & 1;
            else bit2 = (invLo >>> b2) & 1;
            if (bit2) { raw.push(te); raw.push(-te); }
            else { raw.push(-te); raw.push(te); }
        }

        // Key2: 16 bits INVERTED, Manchester MSB first
        var invK2 = (~key2) & 0xFFFF;
        for (var b3 = 15; b3 >= 0; b3--) {
            var bit3 = (invK2 >>> b3) & 1;
            if (bit3) { raw.push(te); raw.push(-te); }
            else { raw.push(-te); raw.push(te); }
        }

        // Final gap: 6000µs LOW
        raw.push(-6000);
    }
    return coalesceRaw(raw);
}

// Coalesce adjacent same-sign raw values into merged pulses
function coalesceRaw(raw) {
    if (raw.length === 0) return "";
    var result = [];
    var cur = raw[0];
    for (var i = 1; i < raw.length; i++) {
        if ((cur > 0 && raw[i] > 0) || (cur < 0 && raw[i] < 0)) {
            cur += raw[i];
        } else {
            result.push(cur);
            cur = raw[i];
        }
    }
    result.push(cur);
    return result.join(" ");
}

// Generate RAW_Data for a rebuilt signal
function encodeRebuilt(rb) {
    if (rb.enc === "pwm") {
        return encodePWM(rb.dataHi, rb.dataLo, rb.bits, rb.teS, rb.teL, rb.preamble, rb.bursts, rb.gap);
    } else if (rb.enc === "psa_manchester") {
        return encodePSAManchester(rb.dataHi, rb.dataLo, rb.valField, 10);
    } else if (rb.enc === "vag_manchester") {
        return encodeVAGT2Manchester(rb.dataHi, rb.dataLo, rb.key2, 10);
    } else {
        return encodeManchester(rb.dataHi, rb.dataLo, rb.bits, rb.teS, rb.preamble, rb.bursts, rb.gap);
    }
}

// Check if a protocol supports full emulate (re-encoding with counter advance)
function canEmulate(proto) {
    if (proto === "Kia V0" || proto === "Kia V1" || proto === "Kia V2") return true;
    if (proto === "Ford V0" || proto === "Subaru" || proto === "Suzuki" || proto === "Chrysler") return true;
    if (proto === "PSA") return true;         // Mode 0x23 only (checked in emulateTransmit)
    if (proto === "VAG T2 TEA") return true;  // TEA encrypt with known key
    return false;
}

// ============================================================================
// BUTTON MENU (protocol-specific button options for emulate mode)
// ============================================================================

// Returns array of {code, name} for available buttons per protocol
function getEmulateButtons(proto) {
    if (proto.indexOf("Kia") >= 0) {
        if (proto.indexOf("V1") >= 0) {
            return [{code: 1, name: "Close"}, {code: 2, name: "Open"}, {code: 3, name: "Boot"}];
        }
        return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}, {code: 3, name: "Trunk"}, {code: 4, name: "Panic"}];
    } else if (proto.indexOf("Ford") >= 0) {
        return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}, {code: 4, name: "Boot"}];
    } else if (proto.indexOf("Suzuki") >= 0) {
        return [{code: 3, name: "Lock"}, {code: 4, name: "Unlock"}, {code: 2, name: "Boot"}, {code: 1, name: "Panic"}];
    } else if (proto.indexOf("Subaru") >= 0) {
        return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}, {code: 3, name: "Boot"}, {code: 4, name: "Panic"}];
    } else if (proto.indexOf("Chrysler") >= 0) {
        return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}, {code: 4, name: "Trunk"}, {code: 8, name: "Panic"}];
    } else if (proto.indexOf("VAG") >= 0) {
        return [{code: 0x20, name: "Lock"}, {code: 0x10, name: "Unlock"}, {code: 0x40, name: "Boot"}];
    } else if (proto.indexOf("StarLine") >= 0) {
        return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}, {code: 3, name: "Boot"}, {code: 4, name: "Panic"}];
    } else if (proto.indexOf("PSA") >= 0) {
        return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}, {code: 4, name: "Boot"}];
    } else if (proto.indexOf("Fiat") >= 0) {
        return [{code: 2, name: "Lock"}, {code: 1, name: "Unlock"}, {code: 4, name: "Boot"}];
    }
    return [{code: 1, name: "Lock"}, {code: 2, name: "Unlock"}];
}

// ============================================================================
// PROTOCOL DECODERS
// ============================================================================

function decodeKiaV0(pulses) {
    var p = PROTO_KIA_V0;
    var step = 0, headerCount = 0, teLast = 0, dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) { step = 1; teLast = dur; headerCount = 0; }
        } else if (step === 1) {
            if (level) { teLast = dur; }
            else {
                if (durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_short, p.te_delta)) { headerCount++; }
                else if (durMatch(dur, p.te_long, p.te_delta) && durMatch(teLast, p.te_long, p.te_delta)) {
                    if (headerCount > 15) { step = 2; dataHi = 0; dataLo = 1; bitCount = 1; }
                    else { step = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur >= (p.te_long + p.te_delta * 2)) {
                    if (bitCount >= p.min_bits) { return extractKiaV0(dataHi, dataLo, bitCount); }
                    step = 0;
                } else { teLast = dur; step = 3; }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = (dataLo << 1) >>> 0; bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | 1) >>> 0; bitCount++; step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
    }
    if (bitCount >= p.min_bits) return extractKiaV0(dataHi, dataLo, bitCount);
    return null;
}

function extractKiaV0(dataHi, dataLo, bitCount) {
    var serial = (((dataHi & 0xFF) << 20) | (dataLo >>> 12)) & 0x0FFFFFFF;
    var button = (dataLo >>> 8) & 0x0F;
    var counter = (dataHi >>> 8) & 0xFFFF;
    var rxCrc = dataLo & 0xFF;
    var crcBytes = [(dataHi >>> 16) & 0xFF, (dataHi >>> 8) & 0xFF, dataHi & 0xFF,
                    (dataLo >>> 24) & 0xFF, (dataLo >>> 16) & 0xFF, (dataLo >>> 8) & 0xFF];
    var calcCrc = kiaCrc8(crcBytes);
    return { proto: "Kia V0", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Kia V0", button),
             counter: counter, crcOk: (rxCrc === calcCrc) };
}

function decodeKiaV1(pulses) {
    var p = PROTO_KIA_V1;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var mPhase = 0, mFirstLevel = false;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0; dataHi = 0; dataLo = 0; bitCount = 0;
            }
        } else if (step === 1) {
            if (!level) {
                if (durMatch(dur, p.te_long, p.te_delta) && durMatch(teLast, p.te_long, p.te_delta)) { headerCount++; teLast = dur; }
                else { step = 0; }
            } else { teLast = dur; }
            if (headerCount > 70) {
                if (!level && durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_long, p.te_delta)) {
                    bitCount = 1; dataLo = 1; dataHi = 0; step = 2; mPhase = 0;
                }
            }
        } else if (step === 2) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            if (!isShort && !isLong) {
                if (bitCount >= p.min_bits) return extractKiaV1(dataHi, dataLo, bitCount);
                step = 0; continue;
            }
            if (isShort) {
                if (mPhase === 0) { mFirstLevel = level; mPhase = 1; }
                else {
                    var bit = mFirstLevel ? 1 : 0;
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    bitCount++; mPhase = 0;
                    if (bitCount >= p.min_bits) return extractKiaV1(dataHi, dataLo, bitCount);
                }
            } else {
                if (mPhase === 1) {
                    var bit = mFirstLevel ? 1 : 0;
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    bitCount++; mFirstLevel = level;
                    if (bitCount >= p.min_bits) return extractKiaV1(dataHi, dataLo, bitCount);
                } else {
                    if (bitCount >= p.min_bits) return extractKiaV1(dataHi, dataLo, bitCount);
                    step = 0;
                }
            }
        }
    }
    if (bitCount >= p.min_bits) return extractKiaV1(dataHi, dataLo, bitCount);
    return null;
}

function extractKiaV1(dataHi, dataLo, bitCount) {
    var serial = ((dataHi << 8) | (dataLo >>> 24)) >>> 0;
    var button = (dataLo >>> 16) & 0xFF;
    var cntLo = (dataLo >>> 8) & 0xFF;
    var cntHi = (dataLo >>> 4) & 0x0F;
    var counter = (cntHi << 8) | cntLo;
    var charData = [];
    charData[0] = (serial >>> 24) & 0xFF; charData[1] = (serial >>> 16) & 0xFF;
    charData[2] = (serial >>> 8) & 0xFF; charData[3] = serial & 0xFF;
    charData[4] = button; charData[5] = cntLo;
    var crc;
    if (cntHi === 0) {
        var offset = (counter >= 0x98) ? button : 1;
        crc = kiaV1Crc4(charData, 6, offset);
    } else if (cntHi >= 0x6) {
        charData[6] = cntHi; crc = kiaV1Crc4(charData, 7, 1);
    } else { crc = kiaV1Crc4(charData, 6, 1); }
    var rxCrc = dataLo & 0x0F;
    return { proto: "Kia V1", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Kia V1", button),
             counter: counter, crcOk: (rxCrc === crc) };
}

function decodeKiaV2(pulses) {
    var p = PROTO_KIA_V2;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var mPhase = 0, mFirstLevel = false;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) { step = 1; teLast = dur; headerCount = 0; }
        } else if (step === 1) {
            if (level) {
                if (durMatch(dur, p.te_long, p.te_delta)) { teLast = dur; headerCount++; }
                else if (durMatch(dur, p.te_short, p.te_delta)) {
                    if (headerCount >= 100) { headerCount = 0; dataHi = 0; dataLo = 1; bitCount = 1; step = 2; mPhase = 0; }
                    else { teLast = dur; }
                } else { step = 0; }
            } else {
                if (durMatch(dur, p.te_long, p.te_delta)) { headerCount++; teLast = dur; }
                else if (durMatch(dur, p.te_short, p.te_delta)) { teLast = dur; }
                else { step = 0; }
            }
        } else if (step === 2) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            if (!isShort && !isLong) {
                if (bitCount >= p.min_bits) return extractKiaV2(dataHi, dataLo, bitCount);
                step = 0; continue;
            }
            if (isShort) {
                if (mPhase === 0) { mFirstLevel = level; mPhase = 1; }
                else {
                    var bit = mFirstLevel ? 1 : 0;
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    bitCount++; mPhase = 0;
                    if (bitCount >= p.min_bits) return extractKiaV2(dataHi, dataLo, bitCount);
                }
            } else {
                if (mPhase === 1) {
                    var bit = mFirstLevel ? 1 : 0;
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    bitCount++; mFirstLevel = level;
                    if (bitCount >= p.min_bits) return extractKiaV2(dataHi, dataLo, bitCount);
                } else {
                    if (bitCount >= p.min_bits) return extractKiaV2(dataHi, dataLo, bitCount);
                    step = 0;
                }
            }
        }
    }
    if (bitCount >= p.min_bits) return extractKiaV2(dataHi, dataLo, bitCount);
    return null;
}

function extractKiaV2(dataHi, dataLo, bitCount) {
    var serial = ((dataHi << 12) | (dataLo >>> 20)) >>> 0;
    var button = (dataLo >>> 16) & 0x0F;
    var rawCount = (dataLo >>> 4) & 0xFFF;
    var counter = (((rawCount >>> 4) | (rawCount << 8)) & 0xFFF);
    var rxCrc = dataLo & 0x0F;
    var calcCrc = kiaV2CalcCrc(dataHi, dataLo);
    return { proto: "Kia V2", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Kia V2", button),
             counter: counter, crcOk: (rxCrc === calcCrc) };
}

function decodeStarLine(pulses) {
    var p = PROTO_STARLINE;
    var teLong2 = p.te_long * 2; var teDelta2 = p.te_delta * 2;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, teLong2, teDelta2)) { step = 1; headerCount++; }
            else if (!level) { headerCount = 0; }
        } else if (step === 1) {
            if (!level && durMatch(dur, teLong2, teDelta2)) { step = 0; }
            else { headerCount = 0; step = 0; }
        }
        if (headerCount > 4 && step === 0) {
            if (level && !durMatch(dur, teLong2, teDelta2)) {
                dataHi = 0; dataLo = 0; bitCount = 0; teLast = dur; step = 3;
            }
        }
        if (step === 2) {
            if (level) {
                if (dur >= (p.te_long + p.te_delta)) {
                    if (bitCount >= p.min_bits && bitCount <= p.min_bits + 2) return extractStarLine(dataHi, dataLo, bitCount);
                    step = 0; headerCount = 0; dataHi = 0; dataLo = 0; bitCount = 0;
                } else { teLast = dur; step = 3; }
            }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = (dataLo << 1) >>> 0; bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | 1) >>> 0; bitCount++; step = 2;
                } else { step = 0; headerCount = 0; }
            }
        }
    }
    if (bitCount >= p.min_bits) return extractStarLine(dataHi, dataLo, bitCount);
    return null;
}

function extractStarLine(dataHi, dataLo, bitCount) {
    // KAT reference: reverse all 64 bits, then fix=hi32 (serial+btn), hop=lo32
    var rev = reverseKey64(dataHi, dataLo);
    var fix = rev.hi >>> 0;
    var hop = rev.lo >>> 0;
    var serial = fix & 0x00FFFFFF;
    var button = (fix >>> 24) & 0xFF;
    return { proto: "StarLine", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("StarLine", button),
             counter: hop & 0xFFFF, crcOk: true, encrypted: true };
}

function decodeScherKhan(pulses) {
    var p = PROTO_SCHERKHAN;
    var teShort2 = p.te_short * 2;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, teShort2, p.te_delta)) { step = 1; teLast = dur; headerCount = 0; }
        } else if (step === 1) {
            if (level) {
                if (durMatch(dur, teShort2, p.te_delta) || durMatch(dur, p.te_short, p.te_delta)) { teLast = dur; }
                else { step = 0; }
            } else {
                if (durMatch(dur, teShort2, p.te_delta) || durMatch(dur, p.te_short, p.te_delta)) {
                    if (durMatch(teLast, teShort2, p.te_delta)) { headerCount++; }
                    else if (durMatch(teLast, p.te_short, p.te_delta)) {
                        if (headerCount >= 2) { step = 2; dataHi = 0; dataLo = 0; bitCount = 1; }
                        else { step = 0; }
                    } else { step = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur >= (p.te_long + p.te_delta * 2)) {
                    if (bitCount >= p.min_bits) return extractScherKhan(dataHi, dataLo, bitCount);
                    step = 0;
                } else { teLast = dur; step = 3; }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = (dataLo << 1) >>> 0; bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | 1) >>> 0; bitCount++; step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
    }
    if (bitCount >= p.min_bits) return extractScherKhan(dataHi, dataLo, bitCount);
    return null;
}

function extractScherKhan(dataHi, dataLo, bitCount) {
    var serial, button, counter;
    if (bitCount >= 51) {
        // Full 51-bit frame per KAT reference
        // button = (data >> 48) & 0x0F → top 3 bits of dataHi (51-32=19, >>16 gives 3 bits)
        button = (dataHi >>> 16) & 0x07;
        // serial = ((data >> 24) & 0x0FFFFFF0) | ((data >> 20) & 0x0F)
        serial = (((dataHi << 8) | (dataLo >>> 24)) & 0x0FFFFFF0) | ((dataLo >>> 20) & 0x0F);
        serial = serial >>> 0;
        counter = dataLo & 0xFFFF;
    } else {
        // Short frame - simplified extraction
        serial = ((dataHi << 24) | (dataLo >>> 8)) >>> 0;
        button = (dataHi >>> 4) & 0x0F;
        counter = dataLo & 0xFFFF;
    }
    return { proto: "Scher-Khan", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Scher-Khan", button),
             counter: counter, crcOk: true, encrypted: true };
}

function decodeSubaru(pulses) {
    var p = PROTO_SUBARU;
    // KAT reference: 6-step state machine
    // Preamble: 20+ LONG (1600us) HIGH/LOW pairs
    // Gap: 2000-3500us LOW
    // Sync: 2000-3500us HIGH + te_long LOW
    // Data: SHORT HIGH (800us) = bit 1, LONG HIGH (1600us) = bit 0
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        if (step === 0) { // CheckPreamble - count LONG pairs
            if (!level) {
                if (durMatch(dur, p.te_long, p.te_delta)) {
                    headerCount++;
                } else if (dur > 2000 && dur < 3500) {
                    // Gap detected
                    if (headerCount > 20) { step = 1; } // FoundGap
                    else { headerCount = 0; }
                } else { headerCount = 0; }
            } else {
                if (durMatch(dur, p.te_long, p.te_delta)) {
                    teLast = dur; headerCount++;
                } else { headerCount = 0; }
            }
        } else if (step === 1) { // FoundGap - look for sync HIGH (2000-3500us)
            if (level && dur > 2000 && dur < 3500) { step = 2; }
            else { step = 0; headerCount = 0; }
        } else if (step === 2) { // FoundSync - look for te_long LOW
            if (!level && durMatch(dur, p.te_long, p.te_delta)) {
                step = 3; dataHi = 0; dataLo = 0; bitCount = 0;
            } else { step = 0; headerCount = 0; }
        } else if (step === 3) { // SaveDuration - HIGH pulse determines bit value
            if (level) {
                if (durMatch(dur, p.te_short, p.te_delta)) {
                    // SHORT HIGH (800us) = bit 1 (KAT verified)
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++;
                    teLast = dur; step = 4;
                } else if (durMatch(dur, p.te_long, p.te_delta)) {
                    // LONG HIGH (1600us) = bit 0 (KAT verified)
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++;
                    teLast = dur; step = 4;
                } else if (dur > 3000) {
                    // End of transmission
                    if (bitCount >= p.min_bits) return extractSubaru(dataHi, dataLo, bitCount);
                    step = 0; headerCount = 0;
                } else { step = 0; headerCount = 0; }
            } else { step = 0; headerCount = 0; }
        } else if (step === 4) { // CheckDuration - LOW pulse validates bit
            if (!level) {
                if (durMatch(dur, p.te_short, p.te_delta) || durMatch(dur, p.te_long, p.te_delta)) {
                    step = 3; // back to SaveDuration for next bit
                } else if (dur > 3000) {
                    // Gap = end of packet
                    if (bitCount >= p.min_bits) return extractSubaru(dataHi, dataLo, bitCount);
                    step = 0; headerCount = 0;
                } else { step = 0; headerCount = 0; }
            } else { step = 0; headerCount = 0; }
        }
    }
    if (bitCount >= p.min_bits) return extractSubaru(dataHi, dataLo, bitCount);
    return null;
}

function extractSubaru(dataHi, dataLo, bitCount) {
    var b0 = (dataHi >>> 24) & 0xFF; var b1 = (dataHi >>> 16) & 0xFF;
    var b2 = (dataHi >>> 8) & 0xFF; var b3 = dataHi & 0xFF;
    var serial = ((b1 << 16) | (b2 << 8) | b3) >>> 0;
    var button = b0 & 0x0F;
    var counter = ((dataLo >>> 16) & 0xFFFF);
    return { proto: "Subaru", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Subaru", button),
             counter: counter, crcOk: true };
}

function decodeFiatV0(pulses) {
    var p = PROTO_FIAT;
    var step = 0, preambleCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var hop = 0, fix = 0, endbyte = 0;
    var mPhase = 0, mFirstLevel = false;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) { step = 1; preambleCount = 0; teLast = dur; }
        } else if (step === 1) {
            if (level) { if (durMatch(dur, p.te_short, p.te_delta)) { preambleCount++; teLast = dur; } else { step = 0; } }
            else {
                if (durMatch(dur, p.te_short, p.te_delta)) { preambleCount++; teLast = dur; }
                else if (preambleCount >= 150) {
                    if (durMatch(dur, 800, p.te_delta)) { step = 2; dataHi = 0; dataLo = 0; bitCount = 0; mPhase = 0; hop = 0; fix = 0; endbyte = 0; }
                    else { step = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            if (!isShort && !isLong) {
                if (bitCount >= 71) return extractFiatV0(hop, fix, endbyte, bitCount);
                if (bitCount >= p.min_bits) return extractFiatV0(dataHi, dataLo, 0, bitCount);
                step = 0; continue;
            }
            if (isShort) {
                if (mPhase === 0) { mFirstLevel = level; mPhase = 1; }
                else {
                    var bit = mFirstLevel ? 1 : 0;
                    if (bitCount < 64) { dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | bit) >>> 0; }
                    bitCount++;
                    if (bitCount === 64) { fix = dataLo; hop = dataHi; dataHi = 0; dataLo = 0; }
                    if (bitCount > 64 && bitCount <= 71) { endbyte = ((endbyte << 1) | bit) & 0x7F; }
                    mPhase = 0;
                    if (bitCount >= 71) return extractFiatV0(hop, fix, endbyte, bitCount);
                }
            } else {
                if (mPhase === 1) {
                    var bit = mFirstLevel ? 1 : 0;
                    if (bitCount < 64) { dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | bit) >>> 0; }
                    bitCount++;
                    if (bitCount === 64) { fix = dataLo; hop = dataHi; dataHi = 0; dataLo = 0; }
                    if (bitCount > 64 && bitCount <= 71) { endbyte = ((endbyte << 1) | bit) & 0x7F; }
                    mFirstLevel = level;
                    if (bitCount >= 71) return extractFiatV0(hop, fix, endbyte, bitCount);
                } else {
                    if (bitCount >= 71) return extractFiatV0(hop, fix, endbyte, bitCount);
                    if (bitCount >= p.min_bits) return extractFiatV0(dataHi, dataLo, 0, bitCount);
                    step = 0;
                }
            }
        }
    }
    if (bitCount >= 71) return extractFiatV0(hop, fix, endbyte, bitCount);
    if (bitCount >= p.min_bits) return extractFiatV0(dataHi, dataLo, 0, bitCount);
    return null;
}

function extractFiatV0(hop, fix, endbyte, bitCount) {
    return { proto: "Fiat V0", bits: bitCount, dataHi: hop, dataLo: fix,
             serial: fix, button: endbyte & 0x7F, btnName: getButtonName("Fiat V0", endbyte & 0x7F),
             counter: hop, crcOk: true, encrypted: true };
}

function decodeFordV0(pulses) {
    var p = PROTO_FORD;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var key2 = 0; var mPhase = 0, mFirstLevel = false;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) { step = 1; headerCount = 0; teLast = dur; }
        } else if (step === 1) {
            if (!level && durMatch(dur, p.te_long, p.te_delta)) { step = 2; teLast = dur; }
            else { step = 0; }
        } else if (step === 2) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) { headerCount++; teLast = dur; step = 3; }
            else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(dur, p.te_long, p.te_delta)) { headerCount++; teLast = dur; step = 2; }
                else if (headerCount >= 4 && dur > 2000) { step = 4; dataHi = 0; dataLo = 0; bitCount = 0; key2 = 0; mPhase = 0; }
                else { step = 0; }
            } else { step = 0; }
        } else if (step === 4) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            if (!isShort && !isLong) {
                if (bitCount >= 80) return extractFordV0(dataHi, dataLo, key2, bitCount);
                step = 0; continue;
            }
            if (isShort) {
                if (mPhase === 0) { mFirstLevel = level; mPhase = 1; }
                else {
                    var bit = mFirstLevel ? 1 : 0;
                    if (bitCount < 64) { dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | bit) >>> 0; }
                    else { key2 = ((key2 << 1) | bit) & 0xFFFF; }
                    bitCount++; mPhase = 0;
                    if (bitCount >= 80) return extractFordV0(dataHi, dataLo, key2, bitCount);
                }
            } else {
                if (mPhase === 1) {
                    var bit = mFirstLevel ? 1 : 0;
                    if (bitCount < 64) { dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | bit) >>> 0; }
                    else { key2 = ((key2 << 1) | bit) & 0xFFFF; }
                    bitCount++; mFirstLevel = level;
                    if (bitCount >= 80) return extractFordV0(dataHi, dataLo, key2, bitCount);
                } else {
                    if (bitCount >= 80) return extractFordV0(dataHi, dataLo, key2, bitCount);
                    step = 0;
                }
            }
        }
    }
    if (bitCount >= 80) return extractFordV0(dataHi, dataLo, key2, bitCount);
    return null;
}

function extractFordV0(dataHi, dataLo, key2, bitCount) {
    var key1Hi = (~dataHi) >>> 0; var key1Lo = (~dataLo) >>> 0; var k2 = (~key2) & 0xFFFF;
    var buf = [];
    buf[0] = (key1Hi >>> 24) & 0xFF; buf[1] = (key1Hi >>> 16) & 0xFF;
    buf[2] = (key1Hi >>> 8) & 0xFF; buf[3] = key1Hi & 0xFF;
    buf[4] = (key1Lo >>> 24) & 0xFF; buf[5] = (key1Lo >>> 16) & 0xFF;
    buf[6] = (key1Lo >>> 8) & 0xFF; buf[7] = key1Lo & 0xFF;
    buf[8] = (k2 >>> 8) & 0xFF; buf[9] = k2 & 0xFF;
    var calcCrc = fordCalcCrc(buf);
    var rxCrc = buf[9] ^ 0x80;
    var crcOk = (calcCrc === rxCrc);
    var tmp = buf[8]; var parity = 0; var parityAny = (tmp !== 0) ? 1 : 0;
    while (tmp) { parity ^= (tmp & 1); tmp >>>= 1; }
    var parityBit = parityAny ? parity : 0;
    var xorByte, limit;
    if (parityBit) { xorByte = buf[7]; limit = 7; } else { xorByte = buf[6]; limit = 6; }
    for (var idx = 1; idx < limit; idx++) { buf[idx] ^= xorByte; }
    if (parityBit === 0) { buf[7] ^= xorByte; }
    var origB7 = buf[7]; buf[7] = (origB7 & 0xAA) | (buf[6] & 0x55); buf[6] = (buf[6] & 0xAA) | (origB7 & 0x55);
    var serialLE = buf[1] | (buf[2] << 8) | (buf[3] << 16) | (buf[4] << 24);
    var serial = ((serialLE & 0xFF) << 24) | (((serialLE >>> 8) & 0xFF) << 16) |
                 (((serialLE >>> 16) & 0xFF) << 8) | ((serialLE >>> 24) & 0xFF);
    serial = serial >>> 0;
    var button = (buf[5] >>> 4) & 0x0F;
    var counter = ((buf[5] & 0x0F) << 16) | (buf[6] << 8) | buf[7];
    return { proto: "Ford V0", bits: bitCount, dataHi: key1Hi, dataLo: key1Lo,
             serial: serial, button: button, btnName: getButtonName("Ford V0", button),
             counter: counter, crcOk: crcOk };
}

function decodeSuzuki(pulses) {
    var p = PROTO_SUZUKI;
    var step = 0, headerCount = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) { step = 1; headerCount = 0; }
        } else if (step === 1) {
            if (!level && durMatch(dur, p.te_short, p.te_delta)) { headerCount++; }
            else if (level) {
                if (headerCount >= 300) {
                    if (durMatch(dur, p.te_long, p.te_delta)) { dataHi = 0; dataLo = 1; bitCount = 1; step = 2; }
                    else if (durMatch(dur, p.te_short, p.te_delta)) { headerCount++; }
                    else { step = 0; }
                } else if (durMatch(dur, p.te_short, p.te_delta)) { /* continue */ }
                else { step = 0; }
            } else { step = 0; }
        } else if (step === 2) {
            if (level) {
                if (durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = (dataLo << 1) >>> 0; bitCount++;
                } else if (durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | 1) >>> 0; bitCount++;
                } else {
                    if (bitCount >= p.min_bits) return extractSuzuki(dataHi, dataLo, bitCount);
                    step = 0; continue;
                }
                if (bitCount >= p.min_bits) return extractSuzuki(dataHi, dataLo, bitCount);
            }
            if (!level && dur > (p.te_long + p.te_delta * 2)) {
                if (bitCount >= p.min_bits) return extractSuzuki(dataHi, dataLo, bitCount);
                step = 0;
            }
        }
    }
    if (bitCount >= p.min_bits) return extractSuzuki(dataHi, dataLo, bitCount);
    return null;
}

function extractSuzuki(dataHi, dataLo, bitCount) {
    // KAT reference: serial = ((data_high & 0xFFF) << 16) | (data_low >> 16)
    //                btn = (data_low >> 12) & 0xF
    //                cnt = (data_high >> 12) & 0xFFFF
    var serial = ((dataHi & 0xFFF) << 16) | (dataLo >>> 16);
    var button = (dataLo >>> 12) & 0x0F;
    var counter = (dataHi >>> 12) & 0xFFFF;
    return { proto: "Suzuki", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Suzuki", button),
             counter: counter, crcOk: true };
}

function decodeGenericPWM(pulses, proto) {
    var p = proto;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) { step = 1; headerCount = 0; teLast = dur; dataHi = 0; dataLo = 0; bitCount = 0; }
        } else if (step === 1) {
            if (level) { teLast = dur; }
            else {
                if (durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_short, p.te_delta)) { headerCount++; }
                else if (headerCount > 3) { step = 2; teLast = dur; }
                else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur >= (p.te_long + p.te_delta * 2)) {
                    if (bitCount >= p.min_bits) return extractGenericPWM(dataHi, dataLo, bitCount, proto);
                    step = 0;
                } else { teLast = dur; step = 3; }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = (dataLo << 1) >>> 0; bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | 1) >>> 0; bitCount++; step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
        if (bitCount >= p.min_bits) return extractGenericPWM(dataHi, dataLo, bitCount, proto);
    }
    if (bitCount >= p.min_bits) return extractGenericPWM(dataHi, dataLo, bitCount, proto);
    return null;
}

function extractGenericPWM(dataHi, dataLo, bitCount, proto) {
    var serial = ((dataHi << 4) | (dataLo >>> 28)) >>> 0;
    var button = (dataLo >>> 24) & 0x0F;
    return { proto: proto.name, bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName(proto.name, button),
             counter: dataLo & 0xFFFF, crcOk: true };
}

// ============================================================================
// KIA V3/V4 DECODER (KeeLoq encrypted, KAT reference)
// ============================================================================

function decodeKiaV3V4(pulses) {
    var p = PROTO_KIA_V3V4;
    // KAT reference: PWM, 16 short-short preamble pairs
    // Sync: V4 = te_long*3/2 (1200us) HIGH, V3 = te_long*3/2 LOW (data inverted)
    // Data: short-short = 0, long-long = 1
    var syncTE = Math.floor(p.te_long * 1.5); // 1200us
    var syncDelta = p.te_delta * 2;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        if (step === 0) { // Look for preamble start
            if (level && durMatch(dur, p.te_short, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) { // Count short-short preamble pairs
            if (level) { teLast = dur; }
            else {
                if (durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_short, p.te_delta)) {
                    headerCount++;
                } else if (headerCount >= 12) {
                    // Look for sync pulse (~1200us) on either HIGH or LOW
                    if (durMatch(dur, syncTE, syncDelta) || durMatch(teLast, syncTE, syncDelta)) {
                        step = 2; dataHi = 0; dataLo = 0; bitCount = 0;
                    } else { step = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) { // Decode data bits (PWM: short-short=0, long-long=1)
            if (level) {
                if (dur >= (p.te_long + p.te_delta * 2)) {
                    if (bitCount >= p.min_bits) return extractKiaV3V4(dataHi, dataLo, bitCount);
                    step = 0;
                } else { teLast = dur; step = 3; }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = (dataLo << 1) >>> 0; bitCount++;
                    step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31); dataLo = ((dataLo << 1) | 1) >>> 0; bitCount++;
                    step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
        if (bitCount >= 68) return extractKiaV3V4(dataHi, dataLo, bitCount);
    }
    if (bitCount >= p.min_bits) return extractKiaV3V4(dataHi, dataLo, bitCount);
    return null;
}

function extractKiaV3V4(dataHi, dataLo, bitCount) {
    // KAT: reverse 64 bits (only 64 fit in u64 despite 68-bit stream), fix=hi32, hop=lo32
    var rev = reverseKey64(dataHi, dataLo);
    var fix = rev.hi >>> 0;
    var hop = rev.lo >>> 0;
    var serial = fix & 0x0FFFFFFF;
    var button = (fix >>> 28) & 0x0F;
    return { proto: "Kia V3/V4", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
             serial: serial, button: button, btnName: getButtonName("Kia V3/V4", button),
             counter: hop & 0xFFFF, crcOk: true, encrypted: true };
}

// ============================================================================
// KIA V5 DECODER (Manchester 400/800µs, 64-bit + 3 CRC, mixer cipher)
// ============================================================================

function decodeKiaV5(pulses) {
    var p = PROTO_KIA_V5;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0, savedKeyHi = 0, savedKeyLo = 0;
    var mState = 1; // 0=Mid0, 1=Mid1, 2=Start0, 3=Start1

    function manchV5(isShort, level) {
        // V5 polarity: ShortLow=0, ShortHigh=1, LongLow=2, LongHigh=3
        var ev = isShort ? (level ? 1 : 0) : (level ? 3 : 2);
        var ns = mState, out = -1;
        if ((mState === 0 || mState === 1) && ev === 0) ns = 2;
        else if ((mState === 0 || mState === 1) && ev === 1) ns = 3;
        else if (mState === 3 && ev === 0) { ns = 1; out = 1; }
        else if (mState === 3 && ev === 2) { ns = 2; out = 1; }
        else if (mState === 2 && ev === 1) { ns = 0; out = 0; }
        else if (mState === 2 && ev === 3) { ns = 3; out = 0; }
        else ns = 1;
        mState = ns;
        return out;
    }

    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        var isShort = durMatch(dur, p.te_short, p.te_delta);
        var isLong = durMatch(dur, p.te_long, p.te_delta);

        if (step === 0) {
            // Reset: wait for SHORT HIGH
            if (level && isShort) { step = 1; teLast = dur; headerCount = 1; mState = 1; }
        } else if (step === 1) {
            // CheckPreamble: count short/long pairs; LONG HIGH with 40+ headers → Data
            if (level) {
                if (isLong && headerCount > 40) {
                    step = 2; bitCount = 0; dataHi = 0; dataLo = 0; savedKeyHi = 0; savedKeyLo = 0;
                } else if (isShort || isLong) { teLast = dur; }
                else { step = 0; }
            } else {
                if (isShort || isLong) { headerCount++; teLast = dur; }
                else { step = 0; }
            }
        } else if (step === 2) {
            // Data: Manchester decode up to 67 bits
            if (!isShort && !isLong) {
                if (bitCount >= 64) {
                    // Parse: YEK then serial/button
                    var yek = computeYEK(savedKeyHi, savedKeyLo);
                    var serial = yek.hi & 0x0FFFFFFF;
                    var button = (yek.hi >>> 28) & 0x0F;
                    return { proto: "Kia V5", bits: bitCount,
                             dataHi: savedKeyHi, dataLo: savedKeyLo,
                             serial: serial, button: button,
                             btnName: getButtonName("Kia V5", button),
                             counter: yek.lo & 0xFFFF, crcOk: true, encrypted: true };
                }
                step = 0; continue;
            }
            if (bitCount <= 66) {
                var bit = manchV5(isShort, level);
                if (bit >= 0) {
                    var carry = (dataLo >>> 31) & 1;
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    dataHi = ((dataHi << 1) | carry) >>> 0;
                    bitCount++;
                    if (bitCount === 64) {
                        savedKeyHi = dataHi; savedKeyLo = dataLo;
                        dataHi = 0; dataLo = 0;
                    }
                }
            }
            teLast = dur;
        }
    }
    return null;
}

// ============================================================================
// KIA V6 DECODER (Manchester 200/400µs, 144-bit = 3×64, AES-128 encrypted)
// Preamble 601+ short pairs → LONG LOW → sync bits 1,1,0,1 → 3 inverted 64-bit parts
// ============================================================================

function decodeKiaV6(pulses) {
    var p = PROTO_KIA_V6;
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var p1Hi = 0, p1Lo = 0, p2Hi = 0, p2Lo = 0, p3 = 0;
    var mState = 1;

    function manchV6(isShort, level) {
        // V6 polarity: inverted (KAT uses 0/2/4/6 event codes)
        var ev;
        if (isShort) { ev = level ? 0 : 2; } else { ev = level ? 4 : 6; }
        var ns = mState, out = -1;
        if ((mState === 0 || mState === 1) && ev === 2) ns = 2;
        else if ((mState === 0 || mState === 1) && ev === 0) ns = 3;
        else if (mState === 3 && ev === 2) { ns = 1; out = 1; }
        else if (mState === 3 && ev === 4) { ns = 2; out = 1; }
        else if (mState === 2 && ev === 0) { ns = 0; out = 0; }
        else if (mState === 2 && ev === 6) { ns = 3; out = 0; }
        else ns = 1;
        mState = ns;
        return out;
    }

    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);
        var isShort = durMatch(dur, p.te_short, p.te_delta);
        var isLong = durMatch(dur, p.te_long, p.te_delta);

        if (step === 0) {
            // Reset: wait for SHORT HIGH
            if (level && isShort) { step = 1; teLast = dur; headerCount = 0; mState = 1; }
        } else if (step === 1) {
            // WaitFirstHigh: count preamble pairs; LONG LOW with 601+ → WaitLongHigh
            if (level) continue;
            if (isLong && headerCount >= 601) { step = 2; teLast = dur; continue; }
            if (!isShort && !isLong) { step = 0; continue; }
            if (durMatch(teLast, p.te_short, p.te_delta)) { headerCount++; teLast = dur; }
            else { step = 0; }
        } else if (step === 2) {
            // WaitLongHigh: expect LONG or SHORT HIGH after LONG LOW
            if (!level) { step = 0; continue; }
            if (!isLong && !isShort) { step = 0; continue; }
            if (!durMatch(teLast, p.te_long, p.te_delta)) { step = 0; continue; }
            // Add sync bits 1,1,0,1
            dataHi = 0; dataLo = 0x0D; bitCount = 4; // 0b1101
            step = 3;
        } else if (step === 3) {
            // Data: Manchester decode 144 bits total
            if (!isShort && !isLong) { step = 0; continue; }
            var bit = manchV6(isShort, level);
            if (bit >= 0) {
                var carry = (dataLo >>> 31) & 1;
                dataLo = ((dataLo << 1) | bit) >>> 0;
                dataHi = ((dataHi << 1) | carry) >>> 0;
                bitCount++;
                if (bitCount === 64) {
                    p1Hi = (~dataHi) >>> 0; p1Lo = (~dataLo) >>> 0;
                    dataHi = 0; dataLo = 0;
                } else if (bitCount === 128) {
                    p2Hi = (~dataHi) >>> 0; p2Lo = (~dataLo) >>> 0;
                    dataHi = 0; dataLo = 0;
                }
            }
            teLast = dur;
            if (bitCount >= 144) {
                p3 = ((~dataLo) & 0xFFFF) >>> 0;
                // Build 16-byte encrypted block for display
                // Cannot decrypt without AES key from keystore, but identify signal
                var serial = ((p1Hi >>> 8) & 0xFFFF00) | (p1Hi & 0xFF);
                return { proto: "Kia V6", bits: 144,
                         dataHi: p1Hi, dataLo: p1Lo,
                         serial: serial, button: 0,
                         btnName: "AES-encrypted",
                         counter: 0, crcOk: false, encrypted: true };
            }
        }
    }
    return null;
}

// ============================================================================
// PSA DECODER (Manchester 250/500µs, preamble 125µs pairs, TEA+XOR decrypt)
// Peugeot/Citroën. 128 bits: key1(64) + validation(16) + rest(48)
// ============================================================================

function decodePSA(pulses) {
    var step = 0, patternCount = 0, prevDur = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var key1Hi = 0, key1Lo = 0, valField = 0;
    var mState = 1;

    function manchPSA(isShort, isHigh) {
        // PSA event: (true,true)=0, (true,false)=1, (false,true)=2, (false,false)=3
        var ev;
        if (isShort) { ev = isHigh ? 0 : 1; } else { ev = isHigh ? 2 : 3; }
        var ns = mState, out = -1;
        if ((mState === 0 || mState === 1) && ev === 0) ns = 3;
        else if ((mState === 0 || mState === 1) && ev === 1) ns = 2;
        else if (mState === 3 && ev === 1) { ns = 1; out = 1; }
        else if (mState === 3 && ev === 3) { ns = 2; out = 1; }
        else if (mState === 2 && ev === 0) { ns = 0; out = 0; }
        else if (mState === 2 && ev === 2) { ns = 3; out = 0; }
        else ns = 1;
        mState = ns;
        return out;
    }

    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);

        if (step === 0) {
            // WaitEdge: HIGH ~125µs
            if (level && abs(dur - 125) < 49) {
                step = 1; prevDur = dur; patternCount = 0;
            }
        } else if (step === 1) {
            // CountPattern: count ~125µs pairs; ~250µs with 0x46+ pairs → Manchester
            if (abs(dur - 125) < 50) { patternCount++; prevDur = dur; }
            else if (abs(dur - 250) < 99 && patternCount >= 0x46) {
                step = 2; dataHi = 0; dataLo = 0; bitCount = 0;
                key1Hi = 0; key1Lo = 0; valField = 0; mState = 1; prevDur = dur;
            } else if (patternCount < 2) { step = 0; }
            else { prevDur = dur; }
        } else if (step === 2) {
            // DecodeManchester
            var isShort = durMatch(dur, 250, 100);
            var isLong = durMatch(dur, 500, 100);
            var isEnd = dur > 1000;

            if (isEnd || bitCount >= 121) {
                if (bitCount >= 96) {
                    // Got enough data - try decrypt
                    return parsePSA(key1Hi, key1Lo, valField, bitCount);
                }
                step = 0; continue;
            }
            if (isShort || isLong) {
                var bit = manchPSA(isShort, level);
                if (bit >= 0) {
                    var carry = (dataLo >>> 31) & 1;
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    dataHi = ((dataHi << 1) | carry) >>> 0;
                    bitCount++;
                    if (bitCount === 64) {
                        key1Hi = dataHi; key1Lo = dataLo;
                        dataHi = 0; dataLo = 0;
                    } else if (bitCount === 80) {
                        valField = dataLo & 0xFFFF;
                        dataHi = 0; dataLo = 0;
                    }
                }
            } else { step = 0; }
            prevDur = dur;
        }
    }
    return null;
}

function parsePSA(key1Hi, key1Lo, valField, bitCount) {
    var seedByte = (key1Hi >>> 24) & 0xFF;
    var serial = 0, btn = 0, counter = 0, decrypted = false;

    if (seedByte === 0x23) {
        // Mode 0x23: XOR cipher ONLY (NO TEA). Matches psa.c psa_build_buffer_mode23.
        // Build buffer from raw captured data (key1 is NOT TEA-encrypted in mode 0x23)
        var buf = [
            seedByte,
            (key1Hi >>> 16) & 0xFF,
            (key1Hi >>> 8) & 0xFF,
            key1Hi & 0xFF,
            (key1Lo >>> 24) & 0xFF,
            (key1Lo >>> 16) & 0xFF,
            (key1Lo >>> 8) & 0xFF,
            key1Lo & 0xFF,
            (valField >>> 8) & 0xFF,
            valField & 0xFF
        ];

        // Validate checksum over encrypted buf[2..7] (matches C: check before decrypt)
        var checksum = psaChecksum(buf);
        var crcOk = (((checksum ^ buf[8]) & 0xF0) === 0);

        if (crcOk) {
            // XOR decrypt buf[2..7]
            psaXorDecrypt(buf);
            serial = ((buf[2] & 0xFF) << 16) | ((buf[3] & 0xFF) << 8) | (buf[4] & 0xFF);
            counter = ((buf[5] & 0xFF) << 8) | (buf[6] & 0xFF);
            btn = buf[8] & 0x0F;
            decrypted = true;
            // Store PSA-specific data for emulate re-encoding
            return { proto: "PSA", bits: bitCount, dataHi: key1Hi, dataLo: key1Lo,
                     serial: serial, button: btn,
                     btnName: getButtonName("PSA", btn),
                     counter: counter, crcOk: true, encrypted: false,
                     psaMode: 0x23, psaBuf1: buf[1], psaBuf7: buf[7], psaBuf9: buf[9] };
        }

        // Brute force: try all 16 top-nibble values for buf[8] (matches C brute force loop)
        for (var tn = 0; tn < 16; tn++) {
            // Rebuild buf from scratch for each attempt
            buf[2] = (key1Hi >>> 8) & 0xFF;
            buf[3] = key1Hi & 0xFF;
            buf[4] = (key1Lo >>> 24) & 0xFF;
            buf[5] = (key1Lo >>> 16) & 0xFF;
            buf[6] = (key1Lo >>> 8) & 0xFF;
            buf[7] = key1Lo & 0xFF;
            buf[8] = (tn << 4) | ((valField >>> 8) & 0x0F);

            checksum = psaChecksum(buf);
            if (((checksum ^ buf[8]) & 0xF0) === 0) {
                psaXorDecrypt(buf);
                serial = ((buf[2] & 0xFF) << 16) | ((buf[3] & 0xFF) << 8) | (buf[4] & 0xFF);
                counter = ((buf[5] & 0xFF) << 8) | (buf[6] & 0xFF);
                btn = buf[8] & 0x0F;
                return { proto: "PSA", bits: bitCount, dataHi: key1Hi, dataLo: key1Lo,
                         serial: serial, button: btn,
                         btnName: getButtonName("PSA", btn),
                         counter: counter, crcOk: true, encrypted: false,
                         psaMode: 0x23, psaBuf1: buf[1], psaBuf7: buf[7], psaBuf9: buf[9] };
            }
        }
    }

    // Mode 0x36 or other: TEA-encrypted (16M brute force infeasible in JS/ESP32)
    // Identify signal but can't decrypt
    return { proto: "PSA", bits: bitCount, dataHi: key1Hi, dataLo: key1Lo,
             serial: serial, button: btn,
             btnName: "encrypted",
             counter: counter, crcOk: false, encrypted: true };
}

// ============================================================================
// VAG DECODER TYPE 1/2 (Manchester 300/600µs, 80 bits, TEA/AUT64)
// VW/Audi/Seat/Skoda. Preamble 201+ pairs of 300µs, gap 600µs, prefix 0xAF3F/0xAF1C
// ============================================================================

function decodeVAG12(pulses) {
    var step = 0, headerCount = 0, teLast = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var key1Hi = 0, key1Lo = 0, key2 = 0;
    var vagType = 0; // 1=AUT64, 2=TEA
    var mState = 1;

    function manchVAG(isShort, level) {
        // VAG event mapping: ShortHigh=level?no→ShortLow:yes→ShortHigh
        // Opposite: SHORT !level → ShortHigh, SHORT level → ShortLow
        var ev;
        if (isShort) { ev = level ? 1 : 0; } // ShortLow : ShortHigh
        else { ev = level ? 3 : 2; }          // LongLow : LongHigh
        var ns = mState, out = -1;
        // Mid→Start, Start→Mid with bit
        if ((mState === 0 || mState === 1) && ev === 0) ns = 3; // ShortHigh→Start1
        else if ((mState === 0 || mState === 1) && ev === 1) ns = 2; // ShortLow→Start0
        else if (mState === 2 && ev === 0) { ns = 0; out = 0; }     // Start0+ShortHigh→Mid0, bit=0
        else if (mState === 3 && ev === 1) { ns = 1; out = 1; }     // Start1+ShortLow→Mid1, bit=1
        else if (mState === 2 && ev === 2) { ns = 3; out = 0; }     // Start0+LongHigh→Start1, bit=0
        else if (mState === 3 && ev === 3) { ns = 2; out = 1; }     // Start1+LongLow→Start0, bit=1
        else ns = 1;
        mState = ns;
        return out;
    }

    var TE_S = 300, TE_L = 600, TE_D = 100;

    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);

        if (step === 0) {
            // Reset: HIGH ~300µs
            if (level && abs(dur - TE_S) <= TE_D) {
                step = 1; headerCount = 0; teLast = dur; mState = 1;
                dataHi = 0; dataLo = 0; bitCount = 0; vagType = 0;
            }
        } else if (step === 1) {
            // Preamble1: count LOW ~300µs pairs
            if (!level) {
                if (abs(dur - TE_S) <= TE_D && abs(teLast - TE_S) <= TE_D) {
                    headerCount++; teLast = dur;
                } else if (headerCount >= 201 && abs(dur - TE_L) <= TE_D && abs(teLast - TE_S) <= TE_D) {
                    // Gap 600µs → Data1
                    step = 2;
                } else { step = 0; }
            }
        } else if (step === 2) {
            // Data1: Manchester decode with 300/600µs timing
            if (bitCount < 96) {
                var isS = abs(dur - TE_S) <= TE_D;
                var isL = abs(dur - TE_L) <= TE_D;
                if (isS || isL) {
                    var bit = manchVAG(isS, level);
                    if (bit >= 0) {
                        var carry = (dataLo >>> 31) & 1;
                        dataLo = ((dataLo << 1) | bit) >>> 0;
                        dataHi = ((dataHi << 1) | carry) >>> 0;
                        bitCount++;
                        // Detect type from prefix at bit 15
                        if (bitCount === 15) {
                            if (dataLo === 0x2F3F) { vagType = 1; dataHi=0; dataLo=0; bitCount=0; }
                            else if (dataLo === 0x2F1C) { vagType = 2; dataHi=0; dataLo=0; bitCount=0; }
                        } else if (bitCount === 64) {
                            key1Hi = (~dataHi) >>> 0; key1Lo = (~dataLo) >>> 0;
                            dataHi = 0; dataLo = 0;
                        }
                    }
                    continue;
                }
            }
            // End-of-data gap (~6000µs)
            if (!level && bitCount === 80) {
                key2 = ((~dataLo) & 0xFFFF) >>> 0;
                return parseVAG12(key1Hi, key1Lo, key2, vagType);
            }
            step = 0;
        }
    }
    return null;
}

function parseVAG12(key1Hi, key1Lo, key2, vagType) {
    var dispatch = key2 & 0xFF;
    var key2hi = (key2 >>> 8) & 0xFF;
    var typeByte = (key1Hi >>> 24) & 0xFF;
    var decrypted = false, serial = 0, btn = 0, counter = 0;

    // Build encrypted block (bytes 1-7 of key1 + key2 high byte)
    var block = [
        (key1Hi >>> 16) & 0xFF, (key1Hi >>> 8) & 0xFF, key1Hi & 0xFF,
        (key1Lo >>> 24) & 0xFF, (key1Lo >>> 16) & 0xFF, (key1Lo >>> 8) & 0xFF,
        key1Lo & 0xFF, key2hi
    ];

    if (vagType === 2) {
        // Type2: TEA decrypt with VAG key
        var v0 = ((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) >>> 0;
        var v1 = ((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) >>> 0;
        var tea = vagTeaDecrypt(v0, v1, VAG_TEA_KEY);
        // Plaintext layout: serial(4B BE) + counter(3B LE) + btn(1B)
        // tea.v0 = serial as big-endian uint32
        serial = tea.v0 >>> 0;
        // tea.v1 = (counter_LSB << 24) | (counter_MID << 16) | (counter_MSB << 8) | btn_byte
        btn = tea.v1 & 0xFF;
        counter = ((tea.v1 >>> 24) & 0xFF) | (((tea.v1 >>> 16) & 0xFF) << 8) | (((tea.v1 >>> 8) & 0xFF) << 16);
        decrypted = true;
    }
    // Type1: AUT64 - can't decrypt without keystore keys, but detect signal

    var pname = vagType === 1 ? "VAG T1 AUT64" : (vagType === 2 ? "VAG T2 TEA" : "VAG T1/T2");
    return { proto: pname, bits: 80, dataHi: key1Hi, dataLo: key1Lo,
             serial: serial, button: btn,
             btnName: decrypted ? getButtonName("VAG", btn) : "encrypted",
             counter: counter & 0xFFFF, crcOk: decrypted, encrypted: !decrypted,
             vagType: vagType, vagDispatch: dispatch, vagTypeByte: typeByte, vagKey2hi: key2hi };
}

// ============================================================================
// VAG DECODER TYPE 3/4 (Manchester 500/1000µs, 80 bits, AUT64)
// Preamble 41+ pairs of 500µs, sync 1000H+500L, 3×750µs pairs, then data
// ============================================================================

function decodeVAG34(pulses) {
    var step = 0, headerCount = 0, teLast = 0, midCount = 0;
    var dataHi = 0, dataLo = 0, bitCount = 0;
    var key1Hi = 0, key1Lo = 0, key2 = 0;
    var mState = 1;

    function manchVAG34(isShort, level) {
        // Same Manchester as VAG12 but with 500/1000µs timing
        var ev;
        if (isShort) { ev = level ? 1 : 0; } else { ev = level ? 3 : 2; }
        var ns = mState, out = -1;
        if ((mState === 0 || mState === 1) && ev === 0) ns = 3;
        else if ((mState === 0 || mState === 1) && ev === 1) ns = 2;
        else if (mState === 2 && ev === 0) { ns = 0; out = 0; }
        else if (mState === 3 && ev === 1) { ns = 1; out = 1; }
        else if (mState === 2 && ev === 2) { ns = 3; out = 0; }
        else if (mState === 3 && ev === 3) { ns = 2; out = 1; }
        else ns = 1;
        mState = ns;
        return out;
    }

    var TE_S = 500, TE_L = 1000, TE_D = 80;

    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0; var dur = abs(pulses[i]);

        if (step === 0) {
            // Reset: HIGH ~500µs
            if (level && abs(dur - TE_S) <= 79) {
                step = 1; headerCount = 0; teLast = dur; midCount = 0;
                dataHi = 0; dataLo = 0; bitCount = 0; mState = 1;
            }
        } else if (step === 1) {
            // Preamble2: count LOW ~500µs pairs
            if (!level) {
                if (abs(dur - TE_S) < TE_D && abs(teLast - TE_S) < TE_D) {
                    headerCount++; teLast = dur;
                } else { step = 0; }
            } else {
                // After 41+ pairs, expect LONG HIGH 1000µs
                if (headerCount >= 41 && abs(dur - TE_L) <= 79 && abs(teLast - TE_S) <= 79) {
                    step = 2; teLast = dur; // Sync2A
                }
            }
        } else if (step === 2) {
            // Sync2A: LOW 500µs after LONG HIGH
            if (!level && abs(dur - TE_S) <= 79 && abs(teLast - TE_L) <= 79) {
                step = 3; teLast = dur; // Sync2B
            } else { step = 0; }
        } else if (step === 3) {
            // Sync2B: HIGH 750µs
            if (level && abs(dur - 750) <= 79) { step = 4; teLast = dur; }
            else { step = 0; }
        } else if (step === 4) {
            // Sync2C: LOW 750µs pairs, count to 3
            if (!level && abs(dur - 750) <= 79 && abs(teLast - 750) <= 79) {
                midCount++;
                if (midCount === 3) {
                    // Start Data2 with initial bit=1
                    dataHi = 0; dataLo = 1; bitCount = 1; mState = 1;
                    step = 5;
                } else { step = 3; }
            } else { step = 0; }
        } else if (step === 5) {
            // Data2: Manchester with 500/1000µs
            var isS = dur >= 380 && dur <= 620;
            var isL = dur >= 880 && dur <= 1120;
            if (isS || isL) {
                var bit = manchVAG34(isS, level);
                if (bit >= 0) {
                    var carry = (dataLo >>> 31) & 1;
                    dataLo = ((dataLo << 1) | bit) >>> 0;
                    dataHi = ((dataHi << 1) | carry) >>> 0;
                    bitCount++;
                    if (bitCount === 64) {
                        key1Hi = dataHi; key1Lo = dataLo;
                        dataHi = 0; dataLo = 0;
                    }
                }
            }
            if (bitCount === 80) {
                key2 = dataLo & 0xFFFF;
                // Type 3/4: AUT64 encrypted, identify but can't decrypt
                var dispatch = key2 & 0xFF;
                var pname = "VAG T3/T4";
                return { proto: pname, bits: 80, dataHi: key1Hi, dataLo: key1Lo,
                         serial: 0, button: 0, btnName: "AUT64-encrypted",
                         counter: 0, crcOk: false, encrypted: true };
            }
        }
    }
    return null;
}

function tryDecode(pulses) {
    var result;
    result = decodeKiaV0(pulses);      if (result) return result;
    result = decodeKiaV1(pulses);      if (result) return result;
    result = decodeKiaV2(pulses);      if (result) return result;
    result = decodeKiaV3V4(pulses);    if (result) return result;
    result = decodeKiaV5(pulses);      if (result) return result;
    result = decodeKiaV6(pulses);      if (result) return result;
    result = decodeStarLine(pulses);   if (result) return result;
    result = decodeScherKhan(pulses);  if (result) return result;
    result = decodeSubaru(pulses);     if (result) return result;
    result = decodeFiatV0(pulses);     if (result) return result;
    result = decodeFordV0(pulses);     if (result) return result;
    result = decodeSuzuki(pulses);     if (result) return result;
    result = decodePSA(pulses);        if (result) return result;
    result = decodeVAG12(pulses);      if (result) return result;
    result = decodeVAG34(pulses);      if (result) return result;
    result = decodeGenericPWM(pulses, PROTO_CHRYSLER); if (result) return result;
    return null;
}

// ============================================================================
// RAW DATA PARSING (FIXED: configurable max pulse filter)
// ============================================================================

function parseRaw(str) {
    var pulses = [];
    var num = "";
    var maxPulse = filterOptions[filterIndex]; // configurable max pulse duration
    var MAX_PULSES = 4096; // memory safety limit for ESP32
    for (var i = 0; i <= str.length; i++) {
        var c = i < str.length ? str.charAt(i) : " ";
        if (c === "-" || (c >= "0" && c <= "9")) { num += c; }
        else if (num.length > 0) {
            var v = parseInt(num, 10);
            if (v !== 0 && abs(v) > 50 && abs(v) < maxPulse) {
                pulses.push(v);
                if (pulses.length >= MAX_PULSES) break;
            }
            num = "";
        }
    }
    return pulses;
}

function extractRawData(content) {
    var allRaw = "";
    var searchFrom = 0;
    while (true) {
        var idx = content.indexOf("RAW_Data:", searchFrom);
        if (idx < 0) break;
        var start = idx + 9;
        var end = content.indexOf("\n", start);
        if (end < 0) end = content.length;
        var segment = content.substring(start, end).trim();
        if (segment.length > 0) {
            if (allRaw.length > 0) allRaw += " ";
            allRaw += segment;
        }
        searchFrom = end + 1;
    }
    return allRaw.length > 0 ? allRaw : null;
}

function extractFrequency(content) {
    var idx = content.indexOf("Frequency:");
    if (idx < 0) return null;
    var start = idx + 10;
    var end = content.indexOf("\n", start);
    if (end < 0) end = content.length;
    var freqStr = content.substring(start, end).trim();
    var freqHz = parseInt(freqStr, 10);
    if (freqHz > 0) { return freqHz / 1000000; }
    return null;
}

// Reconstruct RAW_Data from Bruce RcSwitch format (Protocol:RcSwitch + Key + Bit + TE)
function extractBruceRcSwitchData(content) {
    var keyIdx = content.indexOf("\nKey:");
    if (keyIdx < 0) return null;
    var keyStart = keyIdx + 5;
    var keyEnd = content.indexOf("\n", keyStart);
    if (keyEnd < 0) keyEnd = content.length;
    var keyStr = content.substring(keyStart, keyEnd).trim();

    var bitIdx = content.indexOf("\nBit:");
    if (bitIdx < 0) return null;
    var bitStart = bitIdx + 5;
    var bitEnd = content.indexOf("\n", bitStart);
    if (bitEnd < 0) bitEnd = content.length;
    var numBits = parseInt(content.substring(bitStart, bitEnd).trim(), 10);
    if (!numBits || numBits < 1 || numBits > 64) return null;

    var teIdx = content.indexOf("\nTE:");
    if (teIdx < 0) return null;
    var teStart = teIdx + 4;
    var teEnd = content.indexOf("\n", teStart);
    if (teEnd < 0) teEnd = content.length;
    var te = parseInt(content.substring(teStart, teEnd).trim(), 10);
    if (!te || te < 50 || te > 5000) return null;

    var bits = "";
    var hexStr = keyStr;
    if (hexStr.substring(0, 2) === "0x" || hexStr.substring(0, 2) === "0X") {
        hexStr = hexStr.substring(2);
        var hexToBin = {"0":"0000","1":"0001","2":"0010","3":"0011","4":"0100",
                        "5":"0101","6":"0110","7":"0111","8":"1000","9":"1001",
                        "a":"1010","b":"1011","c":"1100","d":"1101","e":"1110","f":"1111"};
        for (var hi = 0; hi < hexStr.length; hi++) {
            var nibble = hexToBin[hexStr.charAt(hi).toLowerCase()];
            if (nibble) bits += nibble; else bits += "0000";
        }
    } else {
        var val = parseInt(keyStr, 10);
        if (isNaN(val)) return null;
        for (var bi = numBits - 1; bi >= 0; bi--) {
            bits = ((val >> bi) & 1 ? "1" : "0") + bits;
        }
    }
    if (bits.length > numBits) bits = bits.substring(bits.length - numBits);
    while (bits.length < numBits) bits = "0" + bits;

    var pulses = [];
    pulses.push(te);
    pulses.push(-31 * te);
    for (var i = 0; i < bits.length; i++) {
        if (bits.charAt(i) === "1") { pulses.push(3 * te); pulses.push(-te); }
        else { pulses.push(te); pulses.push(-3 * te); }
    }
    return pulses.join(" ");
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

function scanForFiles() {
    loadedFiles = [];
    var dirs = ["/", "/BruceRF/", "/BruceRF/autoSaved/", "/subghz/"];
    for (var d = 0; d < dirs.length; d++) {
        try {
            var files = storage.readdir(dirs[d]);
            if (files && files.length) {
                for (var i = 0; i < files.length; i++) {
                    var fname = files[i];
                    if (fname && fname.length > 4) {
                        var ext = fname.substring(fname.length - 4).toLowerCase();
                        if (ext === ".sub") { loadedFiles.push(dirs[d] + fname); }
                    }
                }
            }
        } catch (eDir) { }
    }
    return loadedFiles.length;
}

// ============================================================================
// IMPROVED FILE MANAGER
// ============================================================================

function fmNormalizePath(p) {
    // Ensure path ends with /
    if (p.length === 0) p = "/";
    if (p.charAt(p.length - 1) !== "/") p += "/";
    // Ensure starts with /
    if (p.charAt(0) !== "/") p = "/" + p;
    return p;
}

function fmParentDir(dir) {
    // Get parent of current dir
    // "/BruceRF/autoSaved/" -> "/BruceRF/"
    // "/BruceRF/" -> "/"
    // "/" -> null (root, no parent)
    if (dir === "/") return null;
    var trimmed = dir;
    if (trimmed.charAt(trimmed.length - 1) === "/") {
        trimmed = trimmed.substring(0, trimmed.length - 1);
    }
    var lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash < 0) return "/";
    return trimmed.substring(0, lastSlash + 1);
}

function fmDirName(dir) {
    // Extract last folder name from path for display
    // "/BruceRF/autoSaved/" -> "autoSaved"
    var trimmed = dir;
    if (trimmed.length > 1 && trimmed.charAt(trimmed.length - 1) === "/") {
        trimmed = trimmed.substring(0, trimmed.length - 1);
    }
    var lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash < 0) return trimmed;
    return trimmed.substring(lastSlash + 1);
}

function browseDirectory(dir) {
    dir = fmNormalizePath(dir);
    fmCurrentDir = dir;
    fmEntries = [];
    fmIndex = 0;

    // Add [BACK] entry if not root
    var parent = fmParentDir(dir);
    if (parent !== null) {
        fmEntries.push({ name: "[BACK]", isDir: true, fullPath: parent, displayName: "[..] " + fmDirName(parent) });
    }

    // Read directory contents with file types
    var dirs_list = [];
    var files_list = [];
    try {
        var entries = storage.readdir(dir, { withFileTypes: true });
        if (entries && entries.length) {
            for (var i = 0; i < entries.length; i++) {
                var e = entries[i];
                if (!e || !e.name) continue;
                var ename = e.name;
                // Skip hidden files/system files
                if (ename.charAt(0) === ".") continue;
                if (e.isDirectory) {
                    dirs_list.push({
                        name: ename,
                        isDir: true,
                        fullPath: dir + ename + "/",
                        displayName: "[DIR] " + ename
                    });
                } else {
                    // Only show .sub files
                    if (ename.length > 4) {
                        var ext = ename.substring(ename.length - 4).toLowerCase();
                        if (ext === ".sub") {
                            files_list.push({
                                name: ename,
                                isDir: false,
                                fullPath: dir + ename,
                                displayName: ename
                            });
                        }
                    }
                }
            }
        }
    } catch (eDir) {
        // Directory doesn't exist or not accessible
    }

    // Sort: directories first (alpha), then files (alpha)
    dirs_list.sort(function(a, b) {
        var al = a.name.toLowerCase(), bl = b.name.toLowerCase();
        if (al < bl) return -1; if (al > bl) return 1; return 0;
    });
    files_list.sort(function(a, b) {
        var al = a.name.toLowerCase(), bl = b.name.toLowerCase();
        if (al < bl) return -1; if (al > bl) return 1; return 0;
    });

    // Append sorted dirs then files after [BACK]
    for (var d = 0; d < dirs_list.length; d++) fmEntries.push(dirs_list[d]);
    for (var f = 0; f < files_list.length; f++) fmEntries.push(files_list[f]);
}

function drawFileManager() {
    clearScreen();
    // Header
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("Browse SUB", 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);

    // Current path - truncate if too long
    setTextSize(1); setTextColor(GRAY);
    var pathStr = fmCurrentDir;
    var maxPathChars = Math.floor(screenWidth / 6) - 2;
    if (pathStr.length > maxPathChars) pathStr = ".." + pathStr.substring(pathStr.length - maxPathChars + 2);
    drawString(pathStr, 6, 23);

    // Entry count
    var subCount = 0;
    for (var c = 0; c < fmEntries.length; c++) { if (!fmEntries[c].isDir) subCount++; }
    var dirCount = 0;
    for (var c2 = 0; c2 < fmEntries.length; c2++) {
        if (fmEntries[c2].isDir && fmEntries[c2].name !== "[BACK]") dirCount++;
    }

    setTextColor(DARKGRAY);
    var infoStr = dirCount + " dir, " + subCount + " sub";
    drawString(infoStr, screenWidth - (infoStr.length * 6) - 6, 23);

    // Content area
    var contentY = 34;
    var itemH = 16;
    var maxVisible = Math.floor((screenHeight - contentY - 16) / itemH);
    if (maxVisible < 3) maxVisible = 3;

    if (fmEntries.length === 0) {
        setTextColor(RED); drawString("Empty directory", 10, contentY + 10);
        setTextColor(WHITE); drawString("No .sub files or folders", 10, contentY + 28);
    } else {
        // Scrolling window centered on fmIndex
        var half = Math.floor(maxVisible / 2);
        var startIdx = fmIndex - half;
        if (startIdx < 0) startIdx = 0;
        if (startIdx + maxVisible > fmEntries.length) startIdx = Math.max(0, fmEntries.length - maxVisible);
        var endIdx = Math.min(fmEntries.length, startIdx + maxVisible);

        var y = contentY;
        for (var i = startIdx; i < endIdx; i++) {
            var entry = fmEntries[i];
            var dname = entry.displayName;

            // Truncate display name
            var maxChars = Math.floor((screenWidth - 30) / 6);
            if (dname.length > maxChars) dname = dname.substring(0, maxChars - 2) + "..";

            if (i === fmIndex) {
                // Selected item highlight
                drawFillRect(4, y, screenWidth - 8, itemH - 2, GRAY);
                if (entry.name === "[BACK]") {
                    setTextColor(ORANGE);
                } else if (entry.isDir) {
                    setTextColor(YELLOW);
                } else {
                    setTextColor(CYAN);
                }
                drawString(">", 8, y + 2);
            } else {
                if (entry.name === "[BACK]") {
                    setTextColor(ORANGE);
                } else if (entry.isDir) {
                    setTextColor(YELLOW);
                } else {
                    setTextColor(WHITE);
                }
            }
            drawString(dname, 20, y + 2);
            y += itemH;
        }

        // Scroll indicators
        if (startIdx > 0) {
            setTextColor(GRAY);
            drawString("^", screenWidth - 10, contentY);
        }
        if (endIdx < fmEntries.length) {
            setTextColor(GRAY);
            drawString("v", screenWidth - 10, y - itemH + 2);
        }
    }

    // Footer
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[^v]Nav [OK]Open [ESC]Back", 5, screenHeight - 11);
}

function handleFileManager() {
    if (getEscPress()) {
        // ESC: go up one level, or exit to menu if at root
        var parent = fmParentDir(fmCurrentDir);
        if (parent !== null) {
            // Restore parent cursor position from stack
            var prevIdx = 0;
            if (fmDirStack.length > 0) {
                var prev = fmDirStack.pop();
                prevIdx = prev.index;
            }
            browseDirectory(parent);
            fmIndex = Math.min(prevIdx, Math.max(0, fmEntries.length - 1));
            drawFileManager();
        } else {
            appState = "menu"; drawCarouselMenu();
        }
        return;
    }

    if (fmEntries.length === 0) return;

    if (getPrevPress()) {
        fmIndex--;
        if (fmIndex < 0) fmIndex = fmEntries.length - 1;
        drawFileManager();
        delay(120);
    }
    if (getNextPress()) {
        fmIndex++;
        if (fmIndex >= fmEntries.length) fmIndex = 0;
        drawFileManager();
        delay(120);
    }
    if (getSelPress()) {
        delay(200);
        var selected = fmEntries[fmIndex];
        if (selected.isDir) {
            if (selected.name === "[BACK]") {
                // Navigate to parent - restore position from stack
                var prevIdx = 0;
                if (fmDirStack.length > 0) {
                    var prev = fmDirStack.pop();
                    prevIdx = prev.index;
                }
                browseDirectory(selected.fullPath);
                fmIndex = Math.min(prevIdx, Math.max(0, fmEntries.length - 1));
            } else {
                // Push current state to stack and enter subdirectory
                fmDirStack.push({ dir: fmCurrentDir, index: fmIndex });
                browseDirectory(selected.fullPath);
            }
            drawFileManager();
        } else {
            // Load the .sub file
            if (!loadAndDecodeFile(selected.fullPath)) {
                drawFileManager();
            }
        }
    }
}

function loadAndDecodeFile(filepath) {
    drawMessage("Loading...\n" + filepath, YELLOW);
    try {
        var content = storage.read(filepath);
        if (!content || content.length < 20) { drawMessage("File empty!", RED); delay(1500); return false; }
        var fileFreq = extractFrequency(content);
        if (fileFreq) { frequency = fileFreq; subghz.setFrequency(frequency); }

        var rawStr = extractRawData(content);

        // Fallback: reconstruct timing from Bruce RcSwitch format
        if ((!rawStr || rawStr.length < 10) && content.indexOf("Protocol: RcSwitch") >= 0) {
            rawStr = extractBruceRcSwitchData(content);
            if (rawStr) { drawMessage("RcSwitch->RAW...", CYAN); delay(300); }
        }

        if (!rawStr || rawStr.length < 10) { drawMessage("No RAW_Data!", RED); delay(1500); return false; }
        var pulses = parseRaw(rawStr);
        var minPulses = sensOptions[sensIndex];
        if (pulses.length < minPulses) { drawMessage("Not enough data!\n" + pulses.length + " pulses", RED); delay(1500); return false; }
        var result = tryDecode(pulses);
        if (result) {
            lastResult = result; lastRawData = rawStr; resultMenuIndex = 0;
            historyAdd(result, rawStr);
            previousState = "filemgr";
            appState = "result"; drawResult(result); delay(300); return true;
        } else { drawMessage("Could not decode!\n" + pulses.length + " pulses parsed", RED); delay(1500); return false; }
    } catch (eLoad) { drawMessage("Error reading file!", RED); delay(1500); return false; }
}

// ============================================================================
// SAVE & TRANSMIT
// ============================================================================

function saveSignal() {
    if (!lastResult || !lastRawData) { drawMessage("No signal to save!", RED); delay(1500); return; }
    drawMessage("Saving signal...", YELLOW);
    var r = lastResult; saveCounter++;
    var protoName = r.proto.replace(/[\s\/]/g, "_");
    var filename = "pp_" + protoName + "_" + saveCounter + ".sub";
    var content = "Filetype: Flipper SubGhz Key File\nVersion: 1\nFrequency: " + Math.floor(frequency * 1000000) + "\nPreset: FuriHalSubGhzPresetOok650Async\nProtocol: RAW\n";
    content += "# ProtoPirate: " + r.proto + "\n# Serial: " + toHex(r.serial, 7) + "\nRAW_Data: " + lastRawData + "\n";
    var saved = false, savePath = "";
    var paths = ["/" + filename, "/BruceRF/" + filename, "/subghz/" + filename];
    for (var sp = 0; sp < paths.length; sp++) {
        try { storage.write(paths[sp], content); saved = true; savePath = paths[sp]; break; } catch (eSave) { }
    }
    if (saved) {
        clearScreen();
        drawFillRect(0, 0, screenWidth, 20, color(0, 60, 0));
        setTextSize(2); setTextColor(GREEN); drawString("SAVED!", 8, 2);
        drawFillRect(0, 20, screenWidth, 1, GRAY);
        setTextSize(1); setTextColor(WHITE);
        drawString("File: " + filename, 10, 35);
        drawString("Path: " + savePath, 10, 50);
        drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
        setTextColor(YELLOW); drawString("Press any key...", 5, screenHeight - 11); delay(500);
        while (!getSelPress() && !getEscPress() && !getPrevPress() && !getNextPress()) { delay(50); }
    } else { drawMessage("Save FAILED!", RED); delay(2000); }
    drawResult(lastResult);
}

function transmitSignal() {
    if (!lastResult || !lastRawData) { drawMessage("No signal to transmit!", RED); delay(1000); return; }

    if (lastResult.encrypted) {
        clearScreen();
        drawFillRect(0, 0, screenWidth, 20, color(60, 0, 0));
        setTextSize(2); setTextColor(RED); drawString("WARNING!", 8, 2);
        drawFillRect(0, 20, screenWidth, 1, GRAY);
        setTextSize(1); setTextColor(WHITE);
        drawString("ENCRYPTED SIGNAL", 10, 35);
        drawString("Replay may desync your key!", 10, 52);
        drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
        setTextColor(GREEN); drawString("[OK] Continue  [ESC] Cancel", 5, screenHeight - 11);
        while (true) { if (getEscPress()) { drawResult(lastResult); return; } if (getSelPress()) { delay(200); break; } delay(50); }
    }

    // TX burst count selection
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("TX Burst", 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1); setTextColor(WHITE); drawString("How many transmissions?", 10, 28);
    var txSelecting = true;
    while (txSelecting) {
        drawFillRect(4, 42, screenWidth - 8, screenHeight - 60, BLACK);
        var optY = 44;
        for (var oi = 0; oi < txBurstOptions.length; oi++) {
            if (oi === txBurstIndex) {
                drawFillRect(6, optY - 1, screenWidth - 12, 14, GRAY);
                setTextColor(CYAN); drawString("> " + txBurstOptions[oi] + "x", 16, optY + 2);
            } else {
                setTextColor(WHITE); drawString("  " + txBurstOptions[oi] + "x", 16, optY + 2);
            }
            optY += 18;
        }
        drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
        setTextColor(YELLOW); drawString("[^v]Nav [OK]TX [ESC]Back", 5, screenHeight - 11);
        if (getEscPress()) { drawResult(lastResult); return; }
        if (getPrevPress()) { txBurstIndex--; if (txBurstIndex < 0) txBurstIndex = txBurstOptions.length - 1; delay(150); }
        if (getNextPress()) { txBurstIndex++; if (txBurstIndex >= txBurstOptions.length) txBurstIndex = 0; delay(150); }
        if (getSelPress()) { delay(200); txSelecting = false; }
        delay(50);
    }
    var burstCount = txBurstOptions[txBurstIndex];

    var tempPath = "/pp_tx.sub";
    var freqHz = Math.floor(frequency * 1000000);
    var txContent = "Filetype: Flipper SubGhz Key File\nVersion: 1\n";
    txContent += "Frequency: " + freqHz + "\n";
    txContent += "Preset: FuriHalSubGhzPresetOok650Async\n";
    txContent += "Protocol: RAW\n";
    txContent += "RAW_Data: " + lastRawData + "\n";

    var usedFsName = "sd";
    var writeOk = false;
    try { writeOk = storage.write({fs: "sd", path: tempPath}, txContent, "write"); } catch(eTxA) { writeOk = false; }
    if (!writeOk) {
        usedFsName = "littlefs";
        try { writeOk = storage.write({fs: "littlefs", path: tempPath}, txContent, "write"); } catch(eTxB) { writeOk = false; }
    }
    if (!writeOk) { drawMessage("TX prepare failed!", RED); delay(1500); drawResult(lastResult); return; }

    drawMessage("TX " + burstCount + "x ...", YELLOW);
    setLongPress(true);
    var txOk = false;
    for (var txI = 0; txI < burstCount; txI++) {
        if (getEscPress()) break;
        txOk = subghz.transmitFile(tempPath, true);
        delay(200);
    }
    setLongPress(false);

    try { storage.remove({fs: usedFsName, path: tempPath}); } catch(eTxC) { }

    if (txOk) { drawMessage("TX " + burstCount + "x OK!", GREEN); }
    else { drawMessage("TX Failed!", RED); }
    delay(1200);
    drawResult(lastResult);
}

// ============================================================================
// EMULATE MODE (re-encode with counter advance + button remapping)
// ============================================================================

function emulateTransmit() {
    // Rebuild the signal with current emulate state
    var rb = null;
    if (emulateProto === "Kia V0") rb = rebuildKiaV0(emulateSerial, emulateButton, emulateCounter);
    else if (emulateProto === "Kia V1") rb = rebuildKiaV1(emulateSerial, emulateButton, emulateCounter);
    else if (emulateProto === "Kia V2") rb = rebuildKiaV2(emulateSerial, emulateButton, emulateCounter);
    else if (emulateProto === "Ford V0") rb = rebuildFordV0(emulateSerial, emulateButton, emulateCounter);
    else if (emulateProto === "Subaru") rb = rebuildSubaru(emulateSerial, emulateButton, emulateCounter);
    else if (emulateProto === "Suzuki") rb = rebuildSuzuki(emulateSerial, emulateButton);
    else if (emulateProto === "Chrysler") rb = rebuildChrysler(emulateSerial, emulateButton, emulateCounter);
    else if (emulateProto === "PSA" && emulatePsaMode === 0x23) rb = rebuildPSA(emulateSerial, emulateButton, emulateCounter, emulatePsaCrc, emulatePsaBuf9);
    else if (emulateProto === "VAG T2 TEA") rb = rebuildVAGT2(emulateSerial, emulateButton, emulateCounter, emulateVagTypeByte, emulateVagDispatch);

    if (!rb) {
        // Encrypted protocol - raw replay
        if (!lastRawData || lastRawData.length < 10) { drawMessage("No raw data!", RED); delay(1000); return; }
        var tempPath = "/pp_emu.sub";
        var freqHz = Math.floor(frequency * 1000000);
        var txContent = "Filetype: Flipper SubGhz Key File\nVersion: 1\nFrequency: " + freqHz +
            "\nPreset: FuriHalSubGhzPresetOok650Async\nProtocol: RAW\nRAW_Data: " + lastRawData + "\n";
        var writeOk = false;
        try { writeOk = storage.write({fs: "sd", path: tempPath}, txContent, "write"); } catch(e1) {}
        if (!writeOk) { try { writeOk = storage.write({fs: "littlefs", path: tempPath}, txContent, "write"); } catch(e2) {} }
        if (writeOk) {
            subghz.transmitFile(tempPath, true);
            try { storage.remove({fs: "sd", path: tempPath}); } catch(e3) { try { storage.remove({fs: "littlefs", path: tempPath}); } catch(e4) {} }
        }
        return;
    }

    // Generate encoded RAW_Data
    var rawData = encodeRebuilt(rb);
    var tempPath = "/pp_emu.sub";
    var freqHz = Math.floor(frequency * 1000000);
    var txContent = "Filetype: Flipper SubGhz Key File\nVersion: 1\nFrequency: " + freqHz +
        "\nPreset: FuriHalSubGhzPresetOok650Async\nProtocol: RAW\nRAW_Data: " + rawData + "\n";

    var writeOk = false;
    var usedFs = "sd";
    try { writeOk = storage.write({fs: "sd", path: tempPath}, txContent, "write"); } catch(e5) {}
    if (!writeOk) { usedFs = "littlefs"; try { writeOk = storage.write({fs: "littlefs", path: tempPath}, txContent, "write"); } catch(e6) {} }

    if (writeOk) {
        subghz.transmitFile(tempPath, true);
        try { storage.remove({fs: usedFs, path: tempPath}); } catch(e7) {}
    }
}

function drawEmulate() {
    clearScreen();
    // Header
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("EMULATE", 8, 2);
    var canEmu = canEmulate(emulateProto);
    if (!canEmu) {
        setTextSize(1); setTextColor(RED);
        drawString("RAW REPLAY", screenWidth - 65, 7);
    }
    drawFillRect(0, 20, screenWidth, 1, GRAY);

    // Protocol info (compact)
    setTextSize(1);
    var y = 24;
    setTextColor(CYAN); drawString(emulateProto, 10, y);
    setTextColor(GREEN); drawString("S:" + toHex(emulateSerial, 7), 90, y);
    setTextColor(YELLOW); drawString(frequency + "MHz", screenWidth - 60, y);
    y += 13;

    // Counter display
    setTextColor(WHITE); drawString("Counter:", 10, y);
    setTextColor(ORANGE); drawString("0x" + toHex(emulateCounter, 4), 62, y);
    var delta = emulateCounter - emulateOrigCounter;
    if (delta > 0) { setTextColor(RED); drawString("(+" + delta + ")", 110, y); }
    y += 2;
    drawFillRect(0, y + 11, screenWidth, 1, GRAY);
    y += 16;

    if (canEmu) {
        // Button selection menu
        setTextColor(YELLOW); drawString("Select button & press [OK] to TX:", 10, y);
        y += 14;
        var itemH = 20;
        for (var i = 0; i < emulateBtnList.length; i++) {
            var iy = y + i * itemH;
            var btn = emulateBtnList[i];
            if (i === emulateBtnIndex) {
                // Selected item: highlighted box
                drawFillRoundRect(8, iy, screenWidth - 16, itemH - 2, 4, color(30, 40, 60));
                drawRoundRect(8, iy, screenWidth - 16, itemH - 2, 4, CYAN);
                setTextColor(CYAN);
                drawString(">", 14, iy + 5);
                setTextColor(WHITE);
                drawString(btn.name, 26, iy + 5);
                setTextColor(GRAY);
                drawString("0x" + toHex(btn.code, 2), screenWidth - 38, iy + 5);
            } else {
                setTextColor(GRAY);
                drawString(" " + btn.name, 14, iy + 5);
                setTextColor(DARKGRAY);
                drawString("0x" + toHex(btn.code, 2), screenWidth - 38, iy + 5);
            }
        }

        // Current selection indicator below list
        var indicatorY = y + emulateBtnList.length * itemH + 4;
        if (indicatorY < screenHeight - 18) {
            setTextColor(PURPLE);
            var selName = emulateBtnList[emulateBtnIndex].name;
            drawString("TX: " + selName + " (0x" + toHex(emulateBtnList[emulateBtnIndex].code, 2) + ")", 10, indicatorY);
        }
    } else {
        // Encrypted: no button selection
        setTextColor(WHITE); drawString("Encrypted signal", 10, y);
        setTextColor(ORANGE); drawString("Only raw replay available", 10, y + 14);
        setTextColor(WHITE); drawString("Press [OK] to replay", 10, y + 32);
    }

    // Footer
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextColor(YELLOW); setTextSize(1);
    if (canEmu) { drawString("[^v]Select [OK]TX [ESC]Back", 5, screenHeight - 11); }
    else { drawString("[OK]Raw TX  [ESC]Back", 5, screenHeight - 11); }
}

function enterEmulate() {
    if (!lastResult) { drawMessage("No signal decoded!", RED); delay(1000); return; }
    emulateProto = lastResult.proto;
    emulateSerial = lastResult.serial;
    emulateCounter = lastResult.counter;
    emulateOrigCounter = lastResult.counter;
    emulateButton = lastResult.button;
    emulateDataHi = lastResult.dataHi;
    emulateDataLo = lastResult.dataLo;
    emulateBitCount = lastResult.bits;
    emulateEncrypted = lastResult.encrypted || false;
    // PSA-specific fields
    emulatePsaMode = lastResult.psaMode || 0;
    emulatePsaCrc = lastResult.psaBuf7 || 0;
    emulatePsaBuf9 = (lastResult.psaBuf9 !== undefined) ? lastResult.psaBuf9 : null;
    // VAG T2-specific fields
    emulateVagTypeByte = lastResult.vagTypeByte || 0;
    emulateVagDispatch = lastResult.vagDispatch || 0;
    // PSA mode 0x23 check: only emulate if mode 0x23 (XOR only)
    if (emulateProto === "PSA" && emulatePsaMode !== 0x23) {
        emulateEncrypted = true; // Force raw replay for non-0x23 modes
    }
    // Build button list for menu selection
    emulateBtnList = getEmulateButtons(emulateProto);
    emulateBtnIndex = 0;
    // Try to pre-select the captured button
    for (var bi = 0; bi < emulateBtnList.length; bi++) {
        if (emulateBtnList[bi].code === emulateButton) { emulateBtnIndex = bi; break; }
    }
    appState = "emulate";
    drawEmulate();
}

function handleEmulate() {
    if (getEscPress()) { delay(200); appState = "result"; drawResult(lastResult); return; }

    var canEmu = canEmulate(emulateProto);

    if (canEmu) {
        // Menu navigation: UP/DOWN to select button, SEL to transmit
        if (getPrevPress()) {
            emulateBtnIndex--;
            if (emulateBtnIndex < 0) emulateBtnIndex = emulateBtnList.length - 1;
            drawEmulate();
            delay(150);
        }
        if (getNextPress()) {
            emulateBtnIndex++;
            if (emulateBtnIndex >= emulateBtnList.length) emulateBtnIndex = 0;
            drawEmulate();
            delay(150);
        }
        if (getSelPress()) {
            delay(200);
            // Set button from menu selection, increment counter, transmit
            emulateButton = emulateBtnList[emulateBtnIndex].code;
            emulateCounter++;
            drawEmulate();
            // Show TX indicator
            drawFillRect(screenWidth - 50, 3, 45, 14, RED);
            setTextSize(1); setTextColor(WHITE); drawString("TX!", screenWidth - 40, 5);
            emulateTransmit();
            delay(300);
            drawEmulate();
        }
    } else {
        // Encrypted: only raw replay on OK press
        if (getSelPress()) {
            delay(200);
            drawFillRect(screenWidth - 50, 3, 45, 14, RED);
            setTextSize(1); setTextColor(WHITE); drawString("TX!", screenWidth - 40, 5);
            emulateTransmit();
            delay(300);
            drawEmulate();
        }
    }
}

// ============================================================================
// ICON DRAWING (using circles, triangles, lines)
// ============================================================================

function drawIconReceive(cx, cy, sz, col) {
    // Antenna with radio wave arcs
    var r = Math.floor(sz * 0.4);
    // Antenna stem
    drawLine(cx, cy - r, cx, cy + r - 2, col);
    drawLine(cx + 1, cy - r, cx + 1, cy + r - 2, col);
    // Base
    drawFillRect(cx - Math.floor(sz * 0.2), cy + r - 2, Math.floor(sz * 0.4), 3, col);
    // Wave arcs (using drawCircle with partial visibility via clipping effect)
    drawCircle(cx, cy - Math.floor(r * 0.3), Math.floor(r * 0.5), col);
    drawCircle(cx, cy - Math.floor(r * 0.3), Math.floor(r * 0.8), col);
}

function drawIconLoadSub(cx, cy, sz, col) {
    // Document with folded corner
    var hw = Math.floor(sz * 0.3);
    var hh = Math.floor(sz * 0.4);
    var fold = Math.floor(sz * 0.12);
    // Document body
    drawRect(cx - hw, cy - hh, hw * 2, hh * 2, col);
    // Folded corner
    drawFillTriangle(cx + hw - fold, cy - hh, cx + hw, cy - hh, cx + hw, cy - hh + fold, col);
    drawLine(cx + hw - fold, cy - hh, cx + hw - fold, cy - hh + fold, col);
    drawLine(cx + hw - fold, cy - hh + fold, cx + hw, cy - hh + fold, col);
    // Text lines
    var lineW = Math.floor(hw * 1.2);
    drawLine(cx - hw + 4, cy - Math.floor(hh * 0.3), cx - hw + 4 + lineW, cy - Math.floor(hh * 0.3), col);
    drawLine(cx - hw + 4, cy + 2, cx - hw + 4 + lineW - 4, cy + 2, col);
    drawLine(cx - hw + 4, cy + Math.floor(hh * 0.35), cx - hw + 4 + lineW, cy + Math.floor(hh * 0.35), col);
}

function drawIconHistory(cx, cy, sz, col) {
    // Clock face
    var r = Math.floor(sz * 0.35);
    drawCircle(cx, cy, r, col);
    drawCircle(cx, cy, r - 1, col);
    // Clock hands
    drawLine(cx, cy, cx, cy - Math.floor(r * 0.6), col);
    drawLine(cx, cy, cx + Math.floor(r * 0.5), cy + Math.floor(r * 0.2), col);
    // Center dot
    drawFillCircle(cx, cy, 2, col);
    // Small arrow at bottom (rewind indicator)
    var ax = cx + Math.floor(r * 0.6);
    var ay = cy + Math.floor(r * 0.7);
    drawFillTriangle(ax, ay - 3, ax + 5, ay, ax, ay + 3, col);
}

function drawIconTiming(cx, cy, sz, col) {
    // Square waveform
    var hw = Math.floor(sz * 0.38);
    var hh = Math.floor(sz * 0.25);
    var stepX = Math.floor(hw * 2 / 5);
    var x0 = cx - hw;
    var yHi = cy - hh;
    var yLo = cy + hh;
    // Draw waveform: high-low-high-low-high
    drawLine(x0, yHi, x0 + stepX, yHi, col);                    // high
    drawLine(x0 + stepX, yHi, x0 + stepX, yLo, col);            // falling
    drawLine(x0 + stepX, yLo, x0 + stepX * 2, yLo, col);        // low
    drawLine(x0 + stepX * 2, yLo, x0 + stepX * 2, yHi, col);    // rising
    drawLine(x0 + stepX * 2, yHi, x0 + stepX * 3, yHi, col);    // high
    drawLine(x0 + stepX * 3, yHi, x0 + stepX * 3, yLo, col);    // falling
    drawLine(x0 + stepX * 3, yLo, x0 + stepX * 4, yLo, col);    // low
    drawLine(x0 + stepX * 4, yLo, x0 + stepX * 4, yHi, col);    // rising
    drawLine(x0 + stepX * 4, yHi, x0 + stepX * 5, yHi, col);    // high
    // Thicken lines
    drawLine(x0, yHi + 1, x0 + stepX, yHi + 1, col);
    drawLine(x0 + stepX * 2, yHi + 1, x0 + stepX * 3, yHi + 1, col);
    drawLine(x0 + stepX * 4, yHi + 1, x0 + stepX * 5, yHi + 1, col);
    drawLine(x0 + stepX, yLo - 1, x0 + stepX * 2, yLo - 1, col);
    drawLine(x0 + stepX * 3, yLo - 1, x0 + stepX * 4, yLo - 1, col);
}

function drawIconSettings(cx, cy, sz, col) {
    // Gear: circle with tooth-like protrusions
    var r = Math.floor(sz * 0.28);
    var ri = Math.floor(sz * 0.15);
    drawCircle(cx, cy, r, col);
    drawCircle(cx, cy, ri, col);
    // Gear teeth (8 teeth using small filled rects around the circle)
    var tw = Math.max(3, Math.floor(sz * 0.08));
    var tl = Math.floor(sz * 0.12);
    // Top, bottom, left, right
    drawFillRect(cx - tw, cy - r - tl, tw * 2, tl, col);
    drawFillRect(cx - tw, cy + r, tw * 2, tl, col);
    drawFillRect(cx - r - tl, cy - tw, tl, tw * 2, col);
    drawFillRect(cx + r, cy - tw, tl, tw * 2, col);
    // Diagonal teeth (4 corners)
    var d = Math.floor(r * 0.7);
    drawFillRect(cx + d - 1, cy - d - tl + 2, tw * 2, tl, col);
    drawFillRect(cx - d - tw, cy - d - tl + 2, tw * 2, tl, col);
    drawFillRect(cx + d - 1, cy + d - 2, tw * 2, tl, col);
    drawFillRect(cx - d - tw, cy + d - 2, tw * 2, tl, col);
}

function drawIconInfo(cx, cy, sz, col) {
    // Circle with "i" inside
    var r = Math.floor(sz * 0.35);
    drawCircle(cx, cy, r, col);
    drawCircle(cx, cy, r - 1, col);
    // "i" dot
    drawFillCircle(cx, cy - Math.floor(r * 0.45), 2, col);
    // "i" stem
    drawFillRect(cx - 1, cy - Math.floor(r * 0.15), 3, Math.floor(r * 0.65), col);
}

function drawIconExit(cx, cy, sz, col) {
    // Door with arrow pointing out
    var hw = Math.floor(sz * 0.25);
    var hh = Math.floor(sz * 0.35);
    // Door frame (partial rect - open on right)
    drawLine(cx - hw, cy - hh, cx - hw, cy + hh, col);
    drawLine(cx - hw, cy - hh, cx + Math.floor(hw * 0.3), cy - hh, col);
    drawLine(cx - hw, cy + hh, cx + Math.floor(hw * 0.3), cy + hh, col);
    // Arrow pointing right
    var arrowX = cx + Math.floor(hw * 0.1);
    drawLine(arrowX, cy, cx + hw + 4, cy, col);
    drawLine(arrowX, cy + 1, cx + hw + 4, cy + 1, col);
    // Arrow head
    drawFillTriangle(cx + hw, cy - 5, cx + hw + 8, cy, cx + hw, cy + 5, col);
}

function drawMenuIcon(idx, cx, cy, sz, col) {
    if (idx === 0) drawIconReceive(cx, cy, sz, col);
    else if (idx === 1) drawIconLoadSub(cx, cy, sz, col);
    else if (idx === 2) drawIconHistory(cx, cy, sz, col);
    else if (idx === 3) drawIconTiming(cx, cy, sz, col);
    else if (idx === 4) drawIconSettings(cx, cy, sz, col);
    else if (idx === 5) drawIconInfo(cx, cy, sz, col);
    else if (idx === 6) drawIconExit(cx, cy, sz, col);
}

// ============================================================================
// HORIZONTAL CAROUSEL MENU
// ============================================================================

function wrapIndex(idx, len) {
    return ((idx % len) + len) % len;
}

function drawCarouselMenu() {
    clearScreen();

    // Header bar
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN);
    drawString("ProtoPirate", 8, 2);
    setTextSize(1); setTextColor(GRAY);
    drawString("v3.0.0", screenWidth - 40, 6);
    drawFillRect(0, 20, screenWidth, 1, GRAY);

    // Status bar below header
    setTextSize(1); setTextColor(WHITE);
    drawString(frequency + " MHz", 8, 24);
    drawString(presetName, screenWidth - 42, 24);
    drawString("Sens:" + sensLabels[sensIndex].substring(0, 6), screenWidth / 2 - 20, 24);

    // Carousel area
    var totalItems = menuLabels.length;
    var centerY = 80;
    var centerX = Math.floor(screenWidth / 2);

    // --- Draw side items (smaller, dimmed) ---
    // Left item
    var leftIdx = wrapIndex(menuIndex - 1, totalItems);
    var leftX = 58;
    drawFillRoundRect(leftX - 22, centerY - 22, 44, 44, 6, DARKGRAY);
    drawRoundRect(leftX - 22, centerY - 22, 44, 44, 6, menuColors[leftIdx]);
    drawMenuIcon(leftIdx, leftX, centerY, 36, menuColors[leftIdx]);
    setTextSize(1); setTextColor(GRAY);
    var leftLabel = menuLabels[leftIdx];
    drawString(leftLabel, leftX - Math.floor(leftLabel.length * 3), centerY + 28);

    // Right item
    var rightIdx = wrapIndex(menuIndex + 1, totalItems);
    var rightX = screenWidth - 58;
    drawFillRoundRect(rightX - 22, centerY - 22, 44, 44, 6, DARKGRAY);
    drawRoundRect(rightX - 22, centerY - 22, 44, 44, 6, menuColors[rightIdx]);
    drawMenuIcon(rightIdx, rightX, centerY, 36, menuColors[rightIdx]);
    setTextSize(1); setTextColor(GRAY);
    var rightLabel = menuLabels[rightIdx];
    drawString(rightLabel, rightX - Math.floor(rightLabel.length * 3), centerY + 28);

    // --- Draw center item (large, bright) ---
    var col = menuColors[menuIndex];
    drawFillRoundRect(centerX - 32, centerY - 32, 64, 64, 8, color(20, 25, 40));
    drawRoundRect(centerX - 32, centerY - 32, 64, 64, 8, col);
    drawRoundRect(centerX - 33, centerY - 33, 66, 66, 9, col);  // double border glow
    drawMenuIcon(menuIndex, centerX, centerY, 56, col);

    // Center label
    setTextSize(2); setTextColor(col);
    var label = menuLabels[menuIndex];
    var labelW = label.length * 12;
    drawString(label, centerX - Math.floor(labelW / 2), centerY + 40);

    // Navigation dots
    var dotY = centerY + 60;
    var dotSpacing = 12;
    var dotsWidth = (totalItems - 1) * dotSpacing;
    var dotStartX = centerX - Math.floor(dotsWidth / 2);
    for (var di = 0; di < totalItems; di++) {
        var dx = dotStartX + di * dotSpacing;
        if (di === menuIndex) {
            drawFillCircle(dx, dotY, 3, col);
        } else {
            drawFillCircle(dx, dotY, 2, GRAY);
        }
    }

    // Navigation arrows
    drawFillTriangle(10, centerY, 22, centerY - 8, 22, centerY + 8, GRAY);   // left arrow
    drawFillTriangle(screenWidth - 10, centerY, screenWidth - 22, centerY - 8, screenWidth - 22, centerY + 8, GRAY); // right

    // Footer
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[< >] Navigate   [OK] Select", Math.floor(screenWidth / 2) - 84, screenHeight - 11);
}

function handleCarouselMenu() {
    if (getPrevPress()) {
        menuIndex--;
        if (menuIndex < 0) menuIndex = menuLabels.length - 1;
        drawCarouselMenu();
        delay(150);
    }
    if (getNextPress()) {
        menuIndex++;
        if (menuIndex >= menuLabels.length) menuIndex = 0;
        drawCarouselMenu();
        delay(150);
    }
    if (getSelPress()) {
        delay(200);
        if (menuIndex === 0) { setLongPress(true); appState = "receive"; drawReceive(); }
        else if (menuIndex === 1) { fmDirStack = []; browseDirectory(FM_START_DIR); appState = "filemgr"; drawFileManager(); }
        else if (menuIndex === 2) { historyIndex = 0; appState = "history"; drawHistoryMenu(); }
        else if (menuIndex === 3) { appState = "timing"; drawTimingAnalyzer(); }
        else if (menuIndex === 4) { settingsIndex = 0; appState = "settings"; drawSettings(); }
        else if (menuIndex === 5) { infoScrollIndex = 0; appState = "info"; drawInfo(); }
        else if (menuIndex === 6) { appState = "exit"; }
    }
}

// ============================================================================
// SETTINGS PAGE
// ============================================================================

function drawSettings() {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("Settings", 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);

    var items = [
        { label: "Sensitivity", value: sensLabels[sensIndex] },
        { label: "Pulse Filter", value: filterLabels[filterIndex] },
        { label: "Frequency", value: frequency + " MHz" },
        { label: "TX Burst", value: txBurstLabels[txBurstIndex] },
        { label: "Preset", value: presetName },
        { label: "Auto-Save", value: autoSave ? "ON" : "OFF" }
    ];

    setTextSize(1);
    var contentY = 24;
    var itemH = 20;
    // Reserve space for hint (separator + 2 lines) and footer
    var hintH = 32;
    var footerH = 14;
    var availH = screenHeight - contentY - hintH - footerH;
    var maxVisible = Math.floor(availH / itemH);
    if (maxVisible < 3) maxVisible = 3;
    if (maxVisible > items.length) maxVisible = items.length;

    // Scrolling window centered on settingsIndex
    var half = Math.floor(maxVisible / 2);
    var startIdx = settingsIndex - half;
    if (startIdx < 0) startIdx = 0;
    if (startIdx + maxVisible > items.length) startIdx = Math.max(0, items.length - maxVisible);
    var endIdx = Math.min(items.length, startIdx + maxVisible);

    var y = contentY;
    for (var i = startIdx; i < endIdx; i++) {
        var iy = y + (i - startIdx) * itemH;
        if (i === settingsIndex) {
            drawFillRoundRect(4, iy, screenWidth - 8, itemH - 2, 4, color(30, 40, 60));
            drawRoundRect(4, iy, screenWidth - 8, itemH - 2, 4, CYAN);
            setTextColor(WHITE); drawString(items[i].label, 12, iy + 5);
            setTextColor(CYAN); drawString(items[i].value, screenWidth - 12 - items[i].value.length * 6, iy + 5);
            // Draw change arrow
            setTextColor(YELLOW);
            drawFillTriangle(screenWidth - items[i].value.length * 6 - 20, iy + 4, screenWidth - items[i].value.length * 6 - 20, iy + 14, screenWidth - items[i].value.length * 6 - 14, iy + 9, YELLOW);
        } else {
            setTextColor(GRAY); drawString(items[i].label, 12, iy + 5);
            setTextColor(WHITE); drawString(items[i].value, screenWidth - 12 - items[i].value.length * 6, iy + 5);
        }
    }

    // Scroll indicators
    if (startIdx > 0) {
        setTextColor(YELLOW);
        drawFillTriangle(Math.floor(screenWidth / 2) - 4, contentY - 1, Math.floor(screenWidth / 2) + 4, contentY - 1, Math.floor(screenWidth / 2), contentY - 5, YELLOW);
    }
    if (endIdx < items.length) {
        var arrowY = y + maxVisible * itemH + 1;
        setTextColor(YELLOW);
        drawFillTriangle(Math.floor(screenWidth / 2) - 4, arrowY, Math.floor(screenWidth / 2) + 4, arrowY, Math.floor(screenWidth / 2), arrowY + 4, YELLOW);
    }

    // Hint area (fixed position above footer)
    var hintY = screenHeight - footerH - hintH;
    drawFillRect(0, hintY, screenWidth, 1, GRAY);
    setTextColor(GRAY);
    var textY = hintY + 6;
    if (settingsIndex === 0) {
        drawString("Min pulses to accept signal.", 10, textY);
        drawString("Lower = more sensitive.", 10, textY + 12);
    } else if (settingsIndex === 1) {
        drawString("Max pulse duration kept.", 10, textY);
        drawString("Higher = keeps sync pulses.", 10, textY + 12);
    } else if (settingsIndex === 2) {
        drawString("RF operating frequency.", 10, textY);
    } else if (settingsIndex === 3) {
        drawString("TX repeat count for replay.", 10, textY);
    } else if (settingsIndex === 4) {
        drawString("OOK modulation preset.", 10, textY);
    } else if (settingsIndex === 5) {
        drawString("Auto-save decoded signals.", 10, textY);
    }

    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[^v]Nav [OK]Change [ESC]Back", 5, screenHeight - 11);
}

function handleSettings() {
    if (getEscPress()) { appState = "menu"; drawCarouselMenu(); return; }
    if (getPrevPress()) {
        settingsIndex--;
        if (settingsIndex < 0) settingsIndex = 5;
        drawSettings(); delay(150);
    }
    if (getNextPress()) {
        settingsIndex++;
        if (settingsIndex > 5) settingsIndex = 0;
        drawSettings(); delay(150);
    }
    if (getSelPress()) {
        delay(200);
        if (settingsIndex === 0) {
            sensIndex = (sensIndex + 1) % sensOptions.length;
        } else if (settingsIndex === 1) {
            filterIndex = (filterIndex + 1) % filterOptions.length;
        } else if (settingsIndex === 2) {
            freqIndex = (freqIndex + 1) % freqOptions.length;
            frequency = freqOptions[freqIndex];
            subghz.setFrequency(frequency);
        } else if (settingsIndex === 3) {
            txBurstIndex = (txBurstIndex + 1) % txBurstOptions.length;
        } else if (settingsIndex === 4) {
            if (presetName === "AM650") presetName = "AM270";
            else presetName = "AM650";
        } else if (settingsIndex === 5) {
            autoSave = !autoSave;
        }
        drawSettings();
    }
}

// ============================================================================
// DRAWING FUNCTIONS
// ============================================================================

function drawReceive() {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 16, HEADERBLUE);
    setTextSize(1); setTextColor(WHITE);
    drawString(frequency + " MHz", 8, 4);
    drawString(presetName, screenWidth - 42, 4);
    drawString("Sens:" + sensOptions[sensIndex], screenWidth / 2 - 16, 4);
    drawFillRect(0, 16, screenWidth, 1, GRAY);

    // Animated receive indicator
    var cx = Math.floor(screenWidth / 2);
    drawCircle(cx, 68, 18, CYAN);
    drawCircle(cx, 68, 12, color(0, 150, 150));
    drawFillCircle(cx, 68, 5, CYAN);

    setTextSize(2); setTextColor(CYAN);
    drawString("LISTENING...", cx - 66, 95);
    setTextSize(1); setTextColor(WHITE);
    drawString("Freq: " + frequency + " MHz", cx - 40, 118);
    setTextColor(YELLOW);
    drawString("Press car key fob button", cx - 70, 134);

    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[ESC] Back to menu", 5, screenHeight - 11);
}

function drawUnknownSignal(pulseCount) {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, color(60, 0, 0));
    setTextSize(2); setTextColor(RED); drawString("UNKNOWN", 8, 2);
    setTextSize(1); setTextColor(GRAY); drawString("Signal", screenWidth - 42, 6);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1); setTextColor(WHITE);
    drawString("Signal captured but", 10, 30);
    drawString("protocol not recognized", 10, 42);
    drawString("Pulses: " + pulseCount, 10, 62);
    drawString("Freq: " + frequency + " MHz", 10, 74);
    drawString("Preset: " + presetName, 10, 86);
    drawFillRect(0, 102, screenWidth, 1, GRAY);
    setTextColor(GREEN); drawString("[OK] Save raw signal", 10, 112);
    setTextColor(CYAN); drawString("[NEXT] Try again", 10, 126);
    setTextColor(YELLOW); drawString("[ESC] Back to menu", 10, 140);
}

function drawResult(r) {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, color(0, 60, 0));
    setTextSize(2); setTextColor(GREEN); drawString("DECODED!", 8, 2);
    setTextSize(1); setTextColor(WHITE); drawString(r.proto, screenWidth - 60, 6);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1);
    var y = 26;
    setTextColor(CYAN);
    drawString(r.proto + " " + r.bits + "-bit @ " + frequency + " MHz", 10, y); y += 14;
    setTextColor(WHITE);
    drawString("Key: " + toHex(r.dataHi, 8) + toHex(r.dataLo, 8), 10, y); y += 12;
    drawString("Serial: " + toHex(r.serial, 7), 10, y);
    drawString("Button: " + r.btnName, 180, y); y += 12;
    drawString("Counter: 0x" + toHex(r.counter, 4), 10, y);
    if (r.crcOk) { setTextColor(GREEN); drawString("CRC: OK", 180, y); }
    else { setTextColor(RED); drawString("CRC: FAIL", 180, y); }
    if (r.encrypted) { setTextColor(ORANGE); drawString("[ENC]", 250, y); }
    y += 4;
    drawFillRect(0, y + 8, screenWidth, 1, GRAY);
    y += 14;
    var opts = ["Transmit", "Emulate", "Save Signal", "Continue"];
    for (var i = 0; i < opts.length; i++) {
        var optYr = y + i * 16;
        if (i === resultMenuIndex) {
            drawFillRect(4, optYr - 1, screenWidth - 8, 14, GRAY);
            setTextColor(CYAN); drawString(">", 8, optYr + 2); drawString(opts[i], 20, optYr + 2);
        } else { setTextColor(WHITE); drawString(opts[i], 20, optYr + 2); }
    }
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[^v]Nav [OK]Sel [ESC]Back", 5, screenHeight - 11);
}

function drawInfo() {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("Protocols", 8, 2);
    setTextSize(1); setTextColor(GRAY); drawString((infoScrollIndex + 1) + "/16", screenWidth - 30, 6);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1);

    var protocols = [
        { name: "Kia V0", desc: "PWM 61-bit, CRC8 poly 0x7F", te: "250/500us", enc: "None" },
        { name: "Kia V1", desc: "Manchester 57-bit, CRC4", te: "800/1600us", enc: "None" },
        { name: "Kia V2", desc: "Manchester 53-bit, CRC4", te: "500/1000us", enc: "None" },
        { name: "Kia V3/V4", desc: "PWM 68-bit, KeeLoq encrypted", te: "400/800us", enc: "KeeLoq" },
        { name: "Kia V5", desc: "Manchester 67-bit, mixer cipher", te: "400/800us", enc: "Mixer/YEK" },
        { name: "Kia V6", desc: "Manchester 144-bit, AES-128", te: "200/400us", enc: "AES-128" },
        { name: "Ford V0", desc: "Manchester 80-bit, matrix CRC", te: "250/500us", enc: "XOR obfusc" },
        { name: "StarLine", desc: "PWM 64-bit, KeeLoq encrypted", te: "250/500us", enc: "KeeLoq" },
        { name: "Scher-Khan", desc: "PWM 35/51-bit", te: "750/1100us", enc: "Encrypted" },
        { name: "Subaru", desc: "PWM 64-bit, preamble detect", te: "800/1600us", enc: "None" },
        { name: "Suzuki", desc: "PWM 64-bit, long preamble", te: "250/500us", enc: "None" },
        { name: "Fiat V0", desc: "Manchester 71-bit, KeeLoq", te: "200/400us", enc: "KeeLoq" },
        { name: "PSA", desc: "Manchester 128-bit, TEA+XOR", te: "250/500us", enc: "TEA" },
        { name: "VAG T1/T2", desc: "Manchester 80-bit, TEA/AUT64", te: "300/600us", enc: "TEA/AUT64" },
        { name: "VAG T3/T4", desc: "Manchester 80-bit, AUT64", te: "500/1000us", enc: "AUT64" },
        { name: "Chrysler", desc: "PWM 64-bit, generic", te: "200/400us", enc: "None" }
    ];

    var contentY = 24;
    var itemH = 28;
    var maxVisible = Math.floor((screenHeight - contentY - 16) / itemH);
    if (maxVisible < 2) maxVisible = 2;

    var half = Math.floor(maxVisible / 2);
    var startIdx = infoScrollIndex - half;
    if (startIdx < 0) startIdx = 0;
    if (startIdx + maxVisible > protocols.length) startIdx = Math.max(0, protocols.length - maxVisible);
    var endIdx = Math.min(protocols.length, startIdx + maxVisible);

    var y = contentY;
    for (var i = startIdx; i < endIdx; i++) {
        var p = protocols[i];
        if (i === infoScrollIndex) {
            drawFillRoundRect(4, y, screenWidth - 8, itemH - 2, 4, color(20, 30, 50));
            drawRoundRect(4, y, screenWidth - 8, itemH - 2, 4, CYAN);
            setTextColor(CYAN); drawString(p.name, 10, y + 3);
            setTextColor(WHITE); drawString(p.desc, 10, y + 15);
            setTextColor(ORANGE);
            var encStr = p.enc;
            drawString(encStr, screenWidth - encStr.length * 6 - 8, y + 3);
        } else {
            setTextColor(GRAY); drawString(p.name, 10, y + 3);
            setTextColor(DARKGRAY); drawString(p.desc, 10, y + 15);
        }
        y += itemH;
    }

    // Scroll indicators
    if (startIdx > 0) {
        drawFillTriangle(Math.floor(screenWidth / 2) - 4, contentY - 1, Math.floor(screenWidth / 2) + 4, contentY - 1, Math.floor(screenWidth / 2), contentY - 5, YELLOW);
    }
    if (endIdx < protocols.length) {
        var arrowY = y + 2;
        drawFillTriangle(Math.floor(screenWidth / 2) - 4, arrowY, Math.floor(screenWidth / 2) + 4, arrowY, Math.floor(screenWidth / 2), arrowY + 4, YELLOW);
    }

    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[^v] Scroll  [ESC] Back", 5, screenHeight - 11);
}

// Old drawLoadMenu/handleLoadMenu removed - replaced by drawFileManager/handleFileManager

function drawHistoryMenu() {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("History", 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1);
    if (history.length === 0) {
        setTextColor(RED); drawString("No signals in history", 10, 40);
        setTextColor(WHITE); drawString("Capture a signal first", 10, 58);
    } else {
        setTextColor(WHITE); drawString("Signals: " + history.length + "/" + HISTORY_MAX, 10, 26);
        var startIdx = Math.max(0, historyIndex - 3);
        var endIdx = Math.min(history.length, startIdx + 7);
        var y = 40;
        for (var i = startIdx; i < endIdx; i++) {
            var text = historyGetTextItem(i);
            if (i === historyIndex) {
                drawFillRect(4, y - 1, screenWidth - 8, 14, GRAY);
                setTextColor(CYAN);
            } else { setTextColor(WHITE); }
            drawString(text, 10, y + 1);
            y += 16;
        }
    }
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[^v]Nav [OK]View [ESC]Back", 5, screenHeight - 11);
}

function drawHistoryView() {
    if (history.length === 0) { drawHistoryMenu(); return; }
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, color(0, 40, 0));
    setTextSize(2); setTextColor(GREEN); drawString("History #" + (historyIndex + 1), 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1); setTextColor(WHITE);
    var text = historyGetFullItem(historyIndex);
    var lines = text.split("\n");
    var y = 28;
    for (var i = 0; i < lines.length; i++) { drawString(lines[i], 10, y); y += 13; }
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[^v]Nav [OK]Decode [ESC]Back", 5, screenHeight - 11);
}

function handleHistoryMenu() {
    if (getEscPress()) { appState = "menu"; drawCarouselMenu(); return; }
    if (history.length === 0) { return; }
    if (getPrevPress()) { historyIndex--; if (historyIndex < 0) historyIndex = history.length - 1; drawHistoryMenu(); delay(150); }
    if (getNextPress()) { historyIndex++; if (historyIndex >= history.length) historyIndex = 0; drawHistoryMenu(); delay(150); }
    if (getSelPress()) { delay(200); appState = "history_view"; drawHistoryView(); }
}

function handleHistoryView() {
    if (getEscPress()) { appState = "history"; drawHistoryMenu(); return; }
    if (getPrevPress()) { historyIndex--; if (historyIndex < 0) historyIndex = history.length - 1; drawHistoryView(); delay(150); }
    if (getNextPress()) { historyIndex++; if (historyIndex >= history.length) historyIndex = 0; drawHistoryView(); delay(150); }
    if (getSelPress()) {
        delay(200);
        var item = history[historyIndex];
        lastResult = item.result; lastRawData = item.rawData; frequency = item.frequency;
        subghz.setFrequency(frequency); resultMenuIndex = 0;
        previousState = "history_view";
        appState = "result"; drawResult(lastResult);
    }
}

// ============================================================================
// TIMING ANALYZER
// ============================================================================

function drawTimingAnalyzer() {
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, HEADERBLUE);
    setTextSize(2); setTextColor(CYAN); drawString("Timing", 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1); setTextColor(WHITE);
    drawString("Capture a signal to", 10, 30);
    drawString("analyze pulse timing", 10, 42);
    drawString("and identify protocol.", 10, 54);
    drawFillRect(0, 68, screenWidth, 1, GRAY);
    setTextColor(CYAN);  drawString("[OK]   Live capture (3s)", 10, 76);
    setTextColor(WHITE); drawString("[NEXT] Analyze last signal", 10, 90);
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW);
    drawString("[OK]Capture [NEXT]Last [ESC]Back", 5, screenHeight - 11);
}

function timingAnalyzeData(pulses) {
    var minDur = 99999, maxDur = 0, sumDur = 0;
    for (var i = 0; i < pulses.length; i++) {
        var d = abs(pulses[i]);
        if (d < minDur) minDur = d;
        if (d > maxDur) maxDur = d;
        sumDur += d;
    }
    var avgDur = Math.floor(sumDur / pulses.length);
    var midDur = Math.floor((minDur + maxDur) / 2);
    var shortCount = 0, longCount = 0;
    for (var i = 0; i < pulses.length; i++) {
        if (abs(pulses[i]) < midDur) shortCount++; else longCount++;
    }
    var teShort = minDur;
    var teLong = maxDur;
    var protos = [
        { name: "Kia V0", te: 250 }, { name: "Kia V1", te: 800 },
        { name: "Kia V2", te: 500 }, { name: "Kia V3/V4", te: 400 },
        { name: "Kia V5", te: 400 }, { name: "Kia V6", te: 200 },
        { name: "Ford V0", te: 250 }, { name: "Suzuki", te: 250 },
        { name: "StarLine", te: 250 }, { name: "Scher-Khan", te: 750 },
        { name: "Subaru", te: 800 }, { name: "Fiat V0", te: 200 },
        { name: "PSA", te: 250 }, { name: "VAG T1/T2", te: 300 },
        { name: "VAG T3/T4", te: 500 }, { name: "Chrysler", te: 200 }
    ];
    var sorted = protos.slice();
    sorted.sort(function(a, b) { return abs(teShort - a.te) - abs(teShort - b.te); });
    clearScreen();
    drawFillRect(0, 0, screenWidth, 20, color(0, 40, 0));
    setTextSize(2); setTextColor(GREEN); drawString("Analysis", 8, 2);
    drawFillRect(0, 20, screenWidth, 1, GRAY);
    setTextSize(1);
    setTextColor(CYAN);  drawString("Pulses: " + pulses.length, 10, 26);
    setTextColor(WHITE); drawString("Short: " + shortCount + "  Long: " + longCount, 160, 26);
    drawFillRect(0, 38, screenWidth, 1, GRAY);
    setTextColor(WHITE);
    drawString("te_short ~ " + teShort + " us", 10, 44);
    drawString("te_long  ~ " + teLong  + " us", 10, 56);
    drawString("avg dur  = " + avgDur  + " us", 10, 68);
    drawFillRect(0, 80, screenWidth, 1, GRAY);
    setTextColor(YELLOW); drawString("Nearest protocols:", 10, 86);
    setTextColor(GREEN);
    for (var i = 0; i < 3 && i < sorted.length; i++) {
        drawString((i+1) + ". " + sorted[i].name + " (te=" + sorted[i].te + ")", 10, 100 + i * 12);
    }
    drawFillRect(0, screenHeight - 14, screenWidth, 14, FOOTERBG);
    setTextSize(1); setTextColor(YELLOW); drawString("[ESC] Back", 5, screenHeight - 11);
    while (!getEscPress()) { delay(50); }
}

function handleTimingAnalyzer() {
    if (getEscPress()) { appState = "menu"; drawCarouselMenu(); return; }
    if (getNextPress()) {
        delay(200);
        if (lastRawData && lastRawData.length > 10) {
            var pulses = parseRaw(lastRawData);
            if (pulses.length > 5) { timingAnalyzeData(pulses); }
            else { drawMessage("Load a .sub file first", YELLOW); delay(1500); }
        } else { drawMessage("No signal loaded", YELLOW); delay(1500); }
        drawTimingAnalyzer(); return;
    }
    if (getSelPress()) {
        delay(200);
        drawMessage("Capturing... (3s)", CYAN);
        var rawContent = subghz.readRaw(3);
        if (rawContent && rawContent.length > 10) {
            var rawStr = extractRawData(rawContent);
            if (!rawStr && rawContent.indexOf(" ") > 0) rawStr = rawContent;
            if (rawStr && rawStr.length > 10) {
                var pulses = parseRaw(rawStr);
                if (pulses.length > 5) { timingAnalyzeData(pulses); }
                else { drawMessage("Too few pulses", RED); delay(1500); }
            } else { drawMessage("No raw data", RED); delay(1500); }
        } else { drawMessage("No signal detected", RED); delay(1500); }
        drawTimingAnalyzer();
    }
}

// ============================================================================
// STATE HANDLERS
// ============================================================================

function handleReceive() {
    if (getEscPress()) {
        setLongPress(false); appState = "menu"; drawCarouselMenu(); return;
    }

    // Blocking read (3 second timeout)
    var rawContent = subghz.readRaw(3);

    if (getEscPress()) {
        setLongPress(false); appState = "menu"; drawCarouselMenu(); return;
    }

    if (!rawContent || rawContent.length <= 10) { drawReceive(); return; }

    var rawStr = extractRawData(rawContent);
    if (!rawStr && rawContent.indexOf(" ") > 0) { rawStr = rawContent; }
    if (!rawStr || rawStr.length <= 10) { drawReceive(); return; }

    var pulses = parseRaw(rawStr);

    var minPulses = sensOptions[sensIndex];
    if (pulses.length < minPulses) {
        setTextColor(YELLOW);
        drawFillRect(5, 50, screenWidth - 10, 14, BLACK);
        drawString("Weak signal (" + pulses.length + " pulses)", 10, 50);
        delay(400);
        drawReceive();
        return;
    }

    drawMessage("Decoding signal...\n" + pulses.length + " pulses", CYAN);
    var result = tryDecode(pulses);

    if (result) {
        lastResult = result;
        lastRawData = rawStr;
        resultMenuIndex = 0;
        historyAdd(result, rawStr);
        // Auto-save if enabled
        if (autoSave) {
            saveCounter++;
            var protoName = result.proto.replace(/[\s\/]/g, "_");
            var asFile = "pp_" + protoName + "_" + saveCounter + ".sub";
            var asContent = "Filetype: Flipper SubGhz Key File\nVersion: 1\nFrequency: " + Math.floor(frequency * 1000000) + "\nPreset: FuriHalSubGhzPresetOok650Async\nProtocol: RAW\n";
            asContent += "# ProtoPirate: " + result.proto + "\n# Serial: " + toHex(result.serial, 7) + "\nRAW_Data: " + rawStr + "\n";
            try { storage.write("/BruceRF/" + asFile, asContent); } catch(e) { try { storage.write("/" + asFile, asContent); } catch(e2) {} }
        }
        setLongPress(false);
        previousState = "receive";
        appState = "result";
        delay(100);
        getPrevPress(); getNextPress(); getSelPress(); getEscPress();
        drawResult(result);
        return;
    }

    setLongPress(false);
    lastRawData = rawStr;
    drawUnknownSignal(pulses.length);

    while (true) {
        if (getEscPress()) { appState = "menu"; drawCarouselMenu(); return; }
        if (getNextPress()) {
            delay(200); setLongPress(true); drawReceive(); return;
        }
        if (getSelPress()) {
            delay(200); saveCounter++;
            var filename = "pp_unknown_" + saveCounter + ".sub";
            var content = "Filetype: Flipper SubGhz Key File\nVersion: 1\nFrequency: " + Math.floor(frequency * 1000000) + "\nPreset: FuriHalSubGhzPresetOok650Async\nProtocol: RAW\nRAW_Data: " + lastRawData + "\n";
            try {
                storage.write("/BruceRF/" + filename, content);
                drawMessage("Saved: " + filename, GREEN);
            } catch(eSaveU) {
                try {
                    storage.write("/" + filename, content);
                    drawMessage("Saved: " + filename, GREEN);
                } catch(eSaveU2) {
                    drawMessage("Save failed!", RED);
                }
            }
            delay(1000);
            setLongPress(true); drawReceive(); return;
        }
        delay(50);
    }
}

function backFromResult() {
    resultMenuIndex = 0;
    if (previousState === "filemgr") { appState = "filemgr"; drawFileManager(); }
    else if (previousState === "history_view") { historyIndex = Math.max(0, historyIndex); appState = "history_view"; drawHistoryView(); }
    else { setLongPress(true); appState = "receive"; drawReceive(); }
}

function handleResult() {
    if (!lastResult) { appState = "menu"; drawCarouselMenu(); return; }
    if (getEscPress()) { delay(200); backFromResult(); return; }
    if (getPrevPress()) { resultMenuIndex--; if (resultMenuIndex < 0) resultMenuIndex = 3; drawResult(lastResult); delay(150); }
    if (getNextPress()) { resultMenuIndex++; if (resultMenuIndex > 3) resultMenuIndex = 0; drawResult(lastResult); delay(150); }
    if (getSelPress()) {
        delay(200);
        if (resultMenuIndex === 0) { transmitSignal(); }
        else if (resultMenuIndex === 1) { enterEmulate(); }
        else if (resultMenuIndex === 2) { saveSignal(); }
        else { backFromResult(); }
    }
}

function handleInfo() {
    if (getEscPress()) { appState = "menu"; drawCarouselMenu(); return; }
    if (getPrevPress()) {
        infoScrollIndex--;
        if (infoScrollIndex < 0) infoScrollIndex = 15;
        drawInfo(); delay(120);
    }
    if (getNextPress()) {
        infoScrollIndex++;
        if (infoScrollIndex > 15) infoScrollIndex = 0;
        drawInfo(); delay(120);
    }
}

// ============================================================================
// MAIN LOOP
// ============================================================================

clearScreen();
drawFillRect(0, 0, screenWidth, screenHeight, BLACK);

// Splash screen with pirate theme
var titleStr = "ProtoPirate";
var titleCharW = 18; // size 3 char width ~18px
var titleW = titleStr.length * titleCharW;
var titleX = Math.floor((screenWidth - titleW) / 2);
var titleY = Math.floor(screenHeight * 0.10);

setTextSize(3); setTextColor(CYAN);
drawString("Proto", titleX, titleY);
setTextColor(WHITE);
drawString("Pirate", titleX + 5 * titleCharW, titleY);

setTextSize(1); setTextColor(GRAY);
var verStr = "Car Key Decoder v3.0.0";
var verW = verStr.length * 6;
drawString(verStr, Math.floor((screenWidth - verW) / 2), titleY + 28);

// Skull & Crossbones
var skx = Math.floor(screenWidth / 2);
var sky = Math.floor(screenHeight * 0.58);

// Crossbones behind skull
drawLine(skx - 20, sky + 12, skx + 20, sky - 12, WHITE);
drawLine(skx - 20, sky - 12, skx + 20, sky + 12, WHITE);
drawLine(skx - 21, sky + 12, skx + 19, sky - 12, WHITE);
drawLine(skx - 21, sky - 12, skx + 19, sky + 12, WHITE);
// Crossbone ball ends
drawFillCircle(skx - 22, sky + 14, 3, WHITE);
drawFillCircle(skx + 22, sky + 14, 3, WHITE);
drawFillCircle(skx - 22, sky - 14, 3, WHITE);
drawFillCircle(skx + 22, sky - 14, 3, WHITE);

// Skull cranium (filled circle)
drawFillCircle(skx, sky - 4, 14, WHITE);
// Jaw (rounded rect below cranium)
drawFillRoundRect(skx - 10, sky + 5, 20, 10, 3, WHITE);

// Eyes (dark holes)
drawFillCircle(skx - 5, sky - 6, 3, BLACK);
drawFillCircle(skx + 5, sky - 6, 3, BLACK);
// Nose (inverted triangle)
drawFillTriangle(skx - 2, sky + 1, skx + 2, sky + 1, skx, sky + 5, BLACK);
// Teeth (dark vertical slits in jaw)
drawLine(skx - 5, sky + 6, skx - 5, sky + 13, BLACK);
drawLine(skx - 2, sky + 6, skx - 2, sky + 13, BLACK);
drawLine(skx + 1, sky + 6, skx + 1, sky + 13, BLACK);
drawLine(skx + 4, sky + 6, skx + 4, sky + 13, BLACK);

// KAT parity badge
setTextSize(1); setTextColor(ORANGE);
var badgeStr = "16 protocols supported!";
var badgeW = badgeStr.length * 6;
drawString(badgeStr, Math.floor((screenWidth - badgeW) / 2), sky + 26);
delay(1800);

subghz.setFrequency(frequency);
drawCarouselMenu();

while (appState !== "exit") {
    if (appState === "menu") handleCarouselMenu();
    else if (appState === "receive") handleReceive();
    else if (appState === "result") handleResult();
    else if (appState === "info") handleInfo();
    else if (appState === "settings") handleSettings();
    else if (appState === "filemgr") handleFileManager();
    else if (appState === "history") handleHistoryMenu();
    else if (appState === "history_view") handleHistoryView();
    else if (appState === "timing") handleTimingAnalyzer();
    else if (appState === "emulate") handleEmulate();
    delay(50);
}

setLongPress(false);
clearScreen();
setTextColor(WHITE);
drawString("Goodbye!", screenWidth / 2 - 25, screenHeight / 2);
delay(600);
