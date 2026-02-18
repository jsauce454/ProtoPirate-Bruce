/**
 * ProtoPirate Car Key Decoder for Bruce Firmware 1.14+
 * Enhanced version with multi-protocol support
 * Protocols: Kia V0/V1/V2, Ford V0, Suzuki, StarLine, Scher-Khan, Subaru, Chrysler
 */

var display = require('display');
var keyboardApi = require('keyboard');
var subghz = require('subghz');
var storage = require('storage');

// Get function references (Bruce pattern)
var width = display.width;
var height = display.height;
var color = display.color;
var drawFillRect = display.drawFillRect;
var drawRect = display.drawRect;
var drawString = display.drawString;
var setTextColor = display.setTextColor;
var setTextSize = display.setTextSize;

var getPrevPress = keyboardApi.getPrevPress;
var getNextPress = keyboardApi.getNextPress;
var getSelPress = keyboardApi.getSelPress;
var getEscPress = keyboardApi.getEscPress;
var setLongPress = keyboardApi.setLongPress;

// Screen
var screenWidth = width();
var screenHeight = height();

// Colors
var BLACK = color(0, 0, 0);
var WHITE = color(255, 255, 255);
var GREEN = color(0, 200, 0);
var RED = color(200, 0, 0);
var CYAN = color(0, 200, 200);
var YELLOW = color(200, 200, 0);
var GRAY = color(80, 80, 80);

// App state
var menuIndex = 0;
var menuItems = ["Receive Signal", "Load Signal", "Set Frequency", "Protocol Info", "Exit"];
var appState = "menu";
var lastResult = null;
var lastRawData = "";
var frequency = 433.92;
var freqOptions = [315.0, 433.92, 868.35];
var freqIndex = 1;  // Default to 433.92
var resultMenuIndex = 0;

// Protocol constants - Enhanced list
var PROTO_KIA_V0 = { name: "Kia V0", te_short: 250, te_long: 500, te_delta: 100, min_bits: 61 };
var PROTO_KIA_V1 = { name: "Kia V1", te_short: 800, te_long: 1600, te_delta: 200, min_bits: 57 };
var PROTO_KIA_V2 = { name: "Kia V2", te_short: 500, te_long: 1000, te_delta: 150, min_bits: 53 };
var PROTO_FORD = { name: "Ford V0", te_short: 250, te_long: 500, te_delta: 100, min_bits: 64 };
var PROTO_SUZUKI = { name: "Suzuki", te_short: 250, te_long: 500, te_delta: 100, min_bits: 64 };
var PROTO_STARLINE = { name: "StarLine", te_short: 250, te_long: 500, te_delta: 120, min_bits: 64 };
var PROTO_SCHERKHAN = { name: "Scher-Khan", te_short: 750, te_long: 1100, te_delta: 160, min_bits: 35 };
var PROTO_SUBARU = { name: "Subaru", te_short: 800, te_long: 1600, te_delta: 200, min_bits: 64 };
var PROTO_FIAT = { name: "Fiat V0", te_short: 200, te_long: 400, te_delta: 100, min_bits: 64 };
var PROTO_KIA_V3V4 = { name: "Kia V3/V4", te_short: 400, te_long: 800, te_delta: 150, min_bits: 68 };
var PROTO_CHRYSLER = { name: "Chrysler", te_short: 200, te_long: 400, te_delta: 120, min_bits: 64 };

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

// CRC8 for Kia V0 (polynomial 0x7F)
function kiaCrc8(bytes) {
    var crc = 0;
    for (var i = 0; i < bytes.length; i++) {
        crc = crc ^ bytes[i];
        for (var j = 0; j < 8; j++) {
            if ((crc & 0x80) !== 0) {
                crc = ((crc << 1) ^ 0x7F) & 0xFF;
            } else {
                crc = (crc << 1) & 0xFF;
            }
        }
    }
    return crc;
}

// CRC4 for Kia V1
function kiaV1Crc4(bytes, count, offset) {
    var crc = 0;
    for (var i = 0; i < count; i++) {
        var b = bytes[i];
        crc ^= ((b & 0x0F) ^ (b >> 4));
    }
    crc = (crc + offset) & 0x0F;
    return crc;
}

// CRC for Kia V2
function kiaV2CalculateCrc(data) {
    var bytes = [];
    var dataWithoutCrc = data >>> 4;
    for (var i = 0; i < 6; i++) {
        bytes[i] = (dataWithoutCrc >>> (i * 8)) & 0xFF;
    }
    var crc = 0;
    for (var i = 0; i < 6; i++) {
        crc ^= (bytes[i] & 0x0F) ^ (bytes[i] >> 4);
    }
    return (crc + 1) & 0x0F;
}

// Button name lookup
function getButtonName(proto, btn) {
    if (proto === "Kia V0" || proto === "Kia V1" || proto === "Kia V2" || proto === "Kia V3/V4") {
        if (btn === 1) return "Lock";
        if (btn === 2) return "Unlock";
        if (btn === 3) return "Trunk";
        if (btn === 4) return "Panic";
    } else if (proto === "Ford V0") {
        if (btn === 1) return "Lock";
        if (btn === 2) return "Unlock";
        if (btn === 4) return "Boot";
    } else if (proto === "Subaru") {
        if (btn === 1) return "Lock";
        if (btn === 2) return "Unlock";
        if (btn === 4) return "Trunk";
        if (btn === 8) return "Panic";
    } else if (proto === "Fiat V0") {
        if (btn === 1) return "Unlock";
        if (btn === 2) return "Lock";
        if (btn === 4) return "Boot";
    } else if (proto === "Chrysler") {
        if (btn === 1) return "Lock";
        if (btn === 2) return "Unlock";
        if (btn === 4) return "Trunk";
        if (btn === 8) return "Panic";
    }
    return "Btn:" + toHex(btn, 2);
}

// ============================================================================
// KIA V0 DECODER (61-bit PWM)
// ============================================================================

function decodeKiaV0(pulses) {
    var p = PROTO_KIA_V0;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) {
            if (level) {
                teLast = dur;
            } else {
                if (durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_short, p.te_delta)) {
                    headerCount++;
                } else if (durMatch(dur, p.te_long, p.te_delta) && durMatch(teLast, p.te_long, p.te_delta)) {
                    if (headerCount > 15) {
                        step = 2; dataHi = 0; dataLo = 1; bitCount = 1;
                    } else { step = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur >= (p.te_long + p.te_delta * 2)) {
                    if (bitCount === p.min_bits) {
                        return extractKiaV0(dataHi, dataLo, bitCount);
                    }
                    step = 0;
                } else { teLast = dur; step = 3; }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++; step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
    }
    return null;
}

function extractKiaV0(dataHi, dataLo, bitCount) {
    var serial = ((dataLo >>> 12) & 0x0FFFFFFF);
    var button = (dataLo >>> 8) & 0x0F;
    var counter = ((dataHi << 24) | (dataLo >>> 8)) >>> 16 & 0xFFFF;
    var rxCrc = dataLo & 0xFF;
    
    var crcBytes = [
        (dataHi >>> 16) & 0xFF, (dataHi >>> 8) & 0xFF, dataHi & 0xFF,
        (dataLo >>> 24) & 0xFF, (dataLo >>> 16) & 0xFF, (dataLo >>> 8) & 0xFF
    ];
    var calcCrc = kiaCrc8(crcBytes);
    
    return {
        proto: "Kia V0", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("Kia V0", button),
        counter: counter, crcOk: (rxCrc === calcCrc)
    };
}

// ============================================================================
// KIA V1 DECODER (57-bit Manchester)
// ============================================================================

function decodeKiaV1(pulses) {
    var p = PROTO_KIA_V1;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    var manchesterState = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) {
            if (!level && durMatch(dur, p.te_long, p.te_delta) && durMatch(teLast, p.te_long, p.te_delta)) {
                headerCount++;
            } else if (level && durMatch(dur, p.te_long, p.te_delta)) {
                teLast = dur;
            } else if (!level && durMatch(dur, p.te_short, p.te_delta) && headerCount > 70) {
                step = 2;
                dataHi = 0; dataLo = 1; bitCount = 1;
            } else {
                step = 0;
            }
        } else if (step === 2) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            
            if (isShort || isLong) {
                if (isShort) {
                    manchesterState++;
                    if (manchesterState === 2) {
                        dataHi = (dataHi << 1) | (dataLo >>> 31);
                        dataLo = ((dataLo << 1) | (level ? 0 : 1)) >>> 0;
                        bitCount++;
                        manchesterState = 0;
                    }
                } else if (isLong) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | (level ? 0 : 1)) >>> 0;
                    bitCount++;
                    manchesterState = 0;
                }
                
                if (bitCount >= p.min_bits) {
                    return extractKiaV1(dataHi, dataLo, bitCount);
                }
            } else {
                step = 0;
            }
        }
    }
    return null;
}

function extractKiaV1(dataHi, dataLo, bitCount) {
    var serial = dataLo >>> 24;
    serial = (serial << 24) | ((dataHi & 0xFF) << 16) | ((dataHi >>> 8) & 0xFF00) | ((dataHi >>> 16) & 0xFF);
    var button = (dataLo >>> 16) & 0xFF;
    var counter = ((dataLo >>> 4) & 0xF) << 8 | ((dataLo >>> 8) & 0xFF);
    var rxCrc = dataLo & 0xF;
    
    var cntHigh = (counter >>> 8) & 0xF;
    var charData = [
        (serial >>> 24) & 0xFF, (serial >>> 16) & 0xFF,
        (serial >>> 8) & 0xFF, serial & 0xFF,
        button, counter & 0xFF
    ];
    
    var offset = 1;
    if (cntHigh === 0 && counter >= 0x98) offset = button;
    var calcCrc = kiaV1Crc4(charData, 6, offset);
    
    return {
        proto: "Kia V1", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial & 0xFFFFFF, button: button, btnName: getButtonName("Kia V1", button),
        counter: counter, crcOk: (rxCrc === calcCrc)
    };
}

// ============================================================================
// KIA V2 DECODER (53-bit Manchester)
// ============================================================================

function decodeKiaV2(pulses) {
    var p = PROTO_KIA_V2;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) {
                teLast = dur; headerCount++;
            } else if (!level && durMatch(dur, p.te_long, p.te_delta)) {
                headerCount++;
            } else if (level && durMatch(dur, p.te_short, p.te_delta) && headerCount >= 100) {
                step = 2;
                dataHi = 0; dataLo = 1; bitCount = 1;
            } else {
                step = 0;
            }
        } else if (step === 2) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            
            if (isShort || isLong) {
                if (isLong) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | (level ? 0 : 1)) >>> 0;
                    bitCount++;
                }
                
                if (bitCount >= p.min_bits) {
                    return extractKiaV2(dataHi, dataLo, bitCount);
                }
            } else {
                step = 0;
            }
        }
    }
    return null;
}

function extractKiaV2(dataHi, dataLo, bitCount) {
    var serial = (dataLo >>> 20) & 0xFFFFFFFF;
    var button = (dataLo >>> 16) & 0x0F;
    var rawCount = (dataLo >>> 4) & 0xFFF;
    var counter = ((rawCount >>> 4) | (rawCount << 8)) & 0xFFF;
    var rxCrc = dataLo & 0x0F;
    
    var calcCrc = kiaV2CalculateCrc(dataLo);
    
    return {
        proto: "Kia V2", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("Kia V2", button),
        counter: counter, crcOk: (rxCrc === calcCrc)
    };
}

// ============================================================================
// STARLINE DECODER (64-bit PWM)
// ============================================================================

function decodeStarLine(pulses) {
    var p = PROTO_STARLINE;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_long * 2, p.te_delta * 2)) {
                step = 1; headerCount = 1;
            }
        } else if (step === 1) {
            if (!level && durMatch(dur, p.te_long * 2, p.te_delta * 2)) {
                step = 0;
            } else if (level && headerCount > 4) {
                dataHi = 0; dataLo = 0; bitCount = 0;
                teLast = dur; step = 2;
            } else if (level && durMatch(dur, p.te_long * 2, p.te_delta * 2)) {
                headerCount++;
            }
        } else if (step === 2) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++;
                }
                
                if (bitCount >= p.min_bits) {
                    return extractStarLine(dataHi, dataLo, bitCount);
                }
            }
            if (level) teLast = dur;
        }
    }
    return null;
}

function extractStarLine(dataHi, dataLo, bitCount) {
    var revHi = 0, revLo = 0;
    for (var i = 0; i < 32; i++) {
        revLo = (revLo << 1) | ((dataHi >>> i) & 1);
        revHi = (revHi << 1) | ((dataLo >>> i) & 1);
    }
    
    var serial = revHi & 0x00FFFFFF;
    var button = revHi >>> 24;
    
    return {
        proto: "StarLine", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("StarLine", button),
        counter: revLo & 0xFFFF, crcOk: true
    };
}

// ============================================================================
// SCHER-KHAN DECODER (35-51 bit PWM)
// ============================================================================

function decodeScherKhan(pulses) {
    var p = PROTO_SCHERKHAN;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_short * 2, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) {
            if (level) {
                if (durMatch(dur, p.te_short * 2, p.te_delta) || durMatch(dur, p.te_short, p.te_delta)) {
                    teLast = dur;
                } else { step = 0; }
            } else {
                if (durMatch(dur, p.te_short * 2, p.te_delta) || durMatch(dur, p.te_short, p.te_delta)) {
                    if (durMatch(teLast, p.te_short * 2, p.te_delta)) {
                        headerCount++;
                    } else if (durMatch(teLast, p.te_short, p.te_delta) && headerCount >= 2) {
                        step = 2;
                        dataHi = 0; dataLo = 0; bitCount = 1;
                    } else { step = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur >= (p.te_delta * 2 + p.te_long)) {
                    if (bitCount >= p.min_bits) {
                        return extractScherKhan(dataHi, dataLo, bitCount);
                    }
                    step = 0;
                } else {
                    teLast = dur; step = 3;
                }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++; step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
    }
    return null;
}

function extractScherKhan(dataHi, dataLo, bitCount) {
    var protoName = "Scher-Khan";
    var serial = 0, button = 0, counter = 0;
    
    if (bitCount === 51) {
        protoName = "MAGIC CODE";
        serial = ((dataLo >>> 24) & 0xFFFFFF0) | ((dataLo >>> 20) & 0x0F);
        button = (dataLo >>> 24) & 0x0F;
        counter = dataLo & 0xFFFF;
    } else if (bitCount === 35) {
        protoName = "MAGIC Static";
    }
    
    return {
        proto: protoName, bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("Scher-Khan", button),
        counter: counter, crcOk: true
    };
}

// ============================================================================
// SUBARU DECODER (64-bit PWM)
// ============================================================================

function decodeSubaru(pulses) {
    var p = PROTO_SUBARU;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_long, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 1;
            }
        } else if (step === 1) {
            if (!level && durMatch(dur, p.te_long, p.te_delta)) {
                headerCount++;
            } else if (level && durMatch(dur, p.te_long, p.te_delta)) {
                teLast = dur; headerCount++;
            } else if (!level && dur > 2000 && dur < 3500 && headerCount > 20) {
                step = 2;
            } else {
                step = 0;
            }
        } else if (step === 2) {
            if (level && dur > 2000 && dur < 3500) {
                step = 3;
            } else {
                step = 0;
            }
        } else if (step === 3) {
            if (!level && durMatch(dur, p.te_long, p.te_delta)) {
                step = 4;
                dataHi = 0; dataLo = 0; bitCount = 0;
            } else {
                step = 0;
            }
        } else if (step === 4) {
            if (level) {
                if (durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++;
                } else if (durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++;
                } else if (dur > 3000 && bitCount >= p.min_bits) {
                    return extractSubaru(dataHi, dataLo, bitCount);
                }
                
                if (bitCount >= p.min_bits) {
                    return extractSubaru(dataHi, dataLo, bitCount);
                }
            }
        }
    }
    return null;
}

function extractSubaru(dataHi, dataLo, bitCount) {
    var b0 = (dataHi >>> 24) & 0xFF;
    var b1 = (dataHi >>> 16) & 0xFF;
    var b2 = (dataHi >>> 8) & 0xFF;
    var b3 = dataHi & 0xFF;
    
    var serial = (b1 << 16) | (b2 << 8) | b3;
    var button = b0 & 0x0F;
    
    return {
        proto: "Subaru", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("Subaru", button),
        counter: dataLo & 0xFFFF, crcOk: true
    };
}

// ============================================================================
// FIAT V0 DECODER (64-bit Manchester)
// ============================================================================

function decodeFiatV0(pulses) {
    var p = PROTO_FIAT;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    var manchesterState = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) {
            if (level) {
                teLast = dur;
            } else {
                if (durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_short, p.te_delta)) {
                    headerCount++;
                } else if (dur > 600 && dur < 1000 && headerCount >= 100) {
                    step = 2;
                    dataHi = 0; dataLo = 0; bitCount = 0;
                    manchesterState = 0;
                } else {
                    step = 0;
                }
            }
        } else if (step === 2) {
            var isShort = durMatch(dur, p.te_short, p.te_delta);
            var isLong = durMatch(dur, p.te_long, p.te_delta);
            
            if (isShort || isLong) {
                if (isShort) {
                    manchesterState++;
                    if (manchesterState === 2) {
                        dataHi = (dataHi << 1) | (dataLo >>> 31);
                        dataLo = ((dataLo << 1) | (level ? 0 : 1)) >>> 0;
                        bitCount++;
                        manchesterState = 0;
                    }
                } else if (isLong) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | (level ? 0 : 1)) >>> 0;
                    bitCount++;
                    manchesterState = 0;
                }
                
                if (bitCount >= p.min_bits) {
                    return extractFiatV0(dataHi, dataLo, bitCount);
                }
            } else {
                if (bitCount >= p.min_bits) {
                    return extractFiatV0(dataHi, dataLo, bitCount);
                }
                step = 0;
            }
        }
    }
    return null;
}

function extractFiatV0(dataHi, dataLo, bitCount) {
    var counter = dataHi;
    var serial = dataLo;
    var button = 0;
    
    return {
        proto: "Fiat V0", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("Fiat V0", button),
        counter: counter, crcOk: true
    };
}

// ============================================================================
// KIA V3/V4 DECODER (68-bit PWM with KeeLoq - raw capture only)
// ============================================================================

function decodeKiaV3V4(pulses) {
    var p = PROTO_KIA_V3V4;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    var isV3 = false;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 1;
            }
        } else if (step === 1) {
            if (level) {
                if (durMatch(dur, p.te_short, p.te_delta)) {
                    teLast = dur;
                } else if (dur > 1000 && dur < 1500) {
                    if (headerCount >= 8) {
                        isV3 = false;
                        step = 2;
                        dataHi = 0; dataLo = 0; bitCount = 0;
                    } else { step = 0; }
                } else { step = 0; }
            } else {
                if (dur > 1000 && dur < 1500) {
                    if (headerCount >= 8) {
                        isV3 = true;
                        step = 2;
                        dataHi = 0; dataLo = 0; bitCount = 0;
                    } else { step = 0; }
                } else if (durMatch(dur, p.te_short, p.te_delta) && durMatch(teLast, p.te_short, p.te_delta)) {
                    headerCount++;
                } else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur > 1000 && dur < 1500) {
                    if (bitCount >= p.min_bits) {
                        return extractKiaV3V4(dataHi, dataLo, bitCount, isV3);
                    }
                    step = 0;
                } else if (durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++;
                } else if (durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++;
                } else { step = 0; }
                
                if (bitCount >= p.min_bits + 4) {
                    return extractKiaV3V4(dataHi, dataLo, bitCount, isV3);
                }
            }
        }
    }
    return null;
}

function reverse8(b) {
    b = ((b & 0xF0) >>> 4) | ((b & 0x0F) << 4);
    b = ((b & 0xCC) >>> 2) | ((b & 0x33) << 2);
    b = ((b & 0xAA) >>> 1) | ((b & 0x55) << 1);
    return b & 0xFF;
}

function extractKiaV3V4(dataHi, dataLo, bitCount, isV3) {
    var protoName = isV3 ? "Kia V3" : "Kia V4";
    
    var b4 = (dataLo >>> 24) & 0xFF;
    var b5 = (dataLo >>> 16) & 0xFF;
    var b6 = (dataLo >>> 8) & 0xFF;
    var b7 = dataLo & 0xFF;
    
    var serial = ((reverse8(b7) & 0xF0) << 20) | (reverse8(b6) << 16) | (reverse8(b5) << 8) | reverse8(b4);
    serial = serial & 0x0FFFFFFF;
    var button = (reverse8(b7) & 0xF0) >>> 4;
    
    return {
        proto: protoName, bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: getButtonName("Kia V3/V4", button),
        counter: 0, crcOk: true, encrypted: true
    };
}

// ============================================================================
// CHRYSLER/TRW DECODER (64-bit KeeLoq @ 315 MHz)
// ============================================================================

function decodeChrysler(pulses) {
    // Try multiple decoding strategies for Chrysler
    var result = decodeChryslerStrict(pulses);
    if (result) return result;
    
    result = decodeChryslerLoose(pulses);
    if (result) return result;
    
    return null;
}

function decodeChryslerStrict(pulses) {
    var step = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    // Chrysler GQ43VT17T: ~200us short, ~400us long
    var teShortMin = 120, teShortMax = 280;
    var teLongMin = 300, teLongMax = 500;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        // Skip noise (very short pulses < 50us)
        if (dur < 50) continue;
        
        // Skip sync pulses (> 600us)
        if (dur > 600) {
            if (bitCount >= 56) {
                return extractChrysler(dataHi, dataLo, bitCount);
            }
            // Reset and keep looking
            step = 0;
            continue;
        }
        
        if (step === 0) {
            if (level && dur >= teShortMin && dur <= teLongMax) {
                step = 1; teLast = dur;
                dataHi = 0; dataLo = 0; bitCount = 0;
            }
        } else if (step === 1) {
            if (!level) {
                var pulseShort = (teLast >= teShortMin && teLast <= teShortMax);
                var pulseLong = (teLast >= teLongMin && teLast <= teLongMax);
                var gapShort = (dur >= teShortMin && dur <= teShortMax);
                var gapLong = (dur >= teLongMin && dur <= teLongMax);
                
                if (pulseShort && gapLong) {
                    // Bit 0
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++;
                } else if (pulseLong && gapShort) {
                    // Bit 1
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++;
                }
                // Continue regardless - try to find more bits
                step = 0;
            } else {
                // Another high pulse - update teLast
                teLast = dur;
            }
        }
    }
    
    if (bitCount >= 56) {
        return extractChrysler(dataHi, dataLo, bitCount);
    }
    return null;
}

function decodeChryslerLoose(pulses) {
    // Very loose decoder - just look for any PWM-like pattern
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    // Find pulses in the 100-500us range and try to decode
    var validPulses = [];
    for (var i = 0; i < pulses.length; i++) {
        var dur = abs(pulses[i]);
        if (dur >= 100 && dur <= 600) {
            validPulses.push(pulses[i]);
        }
    }
    
    if (validPulses.length < 20) return null;
    
    // Calculate average to determine short vs long threshold
    var sum = 0;
    for (var i = 0; i < validPulses.length; i++) {
        sum += abs(validPulses[i]);
    }
    var avg = sum / validPulses.length;
    var threshold = avg;  // Use average as threshold
    
    // Decode using threshold
    for (var i = 0; i < validPulses.length - 1; i += 2) {
        var pulse = abs(validPulses[i]);
        var gap = abs(validPulses[i + 1]);
        
        if (validPulses[i] > 0) {  // pulse is high
            if (pulse < threshold && gap > threshold) {
                // Short-Long = 0
                dataHi = (dataHi << 1) | (dataLo >>> 31);
                dataLo = (dataLo << 1) >>> 0;
                bitCount++;
            } else if (pulse > threshold && gap < threshold) {
                // Long-Short = 1
                dataHi = (dataHi << 1) | (dataLo >>> 31);
                dataLo = ((dataLo << 1) | 1) >>> 0;
                bitCount++;
            }
        }
    }
    
    if (bitCount >= 40) {  // Lower threshold for loose decoder
        return extractChrysler(dataHi, dataLo, bitCount);
    }
    return null;
}

function extractChrysler(dataHi, dataLo, bitCount) {
    // KeeLoq structure: [Encrypted 32-bit][Serial 28-bit][Button 4-bit]
    // The encrypted portion contains the rolling code
    var encrypted = dataHi;
    var serial = (dataLo >>> 4) & 0x0FFFFFFF;
    var button = dataLo & 0x0F;
    
    return {
        proto: "Chrysler",
        bits: bitCount,
        dataHi: dataHi,
        dataLo: dataLo,
        serial: serial,
        button: button,
        btnName: getButtonName("Chrysler", button),
        counter: encrypted & 0xFFFF,  // Display lower 16 bits of encrypted (visible counter)
        crcOk: true,
        encrypted: true
    };
}

// ============================================================================
// GENERIC PWM DECODER (Ford, Suzuki fallback)
// ============================================================================

function decodeGenericPWM(pulses, proto) {
    var p = proto;
    var step = 0;
    var headerCount = 0;
    var teLast = 0;
    var dataHi = 0;
    var dataLo = 0;
    var bitCount = 0;
    
    for (var i = 0; i < pulses.length; i++) {
        var level = pulses[i] > 0;
        var dur = abs(pulses[i]);
        
        if (step === 0) {
            if (level && durMatch(dur, p.te_short, p.te_delta)) {
                step = 1; teLast = dur; headerCount = 0;
            }
        } else if (step === 1) {
            if (level) { teLast = dur; }
            else {
                if (durMatch(dur, p.te_short, p.te_delta)) {
                    headerCount++;
                    if (headerCount >= 8) { step = 2; dataHi = 0; dataLo = 0; bitCount = 0; }
                } else { step = 0; }
            }
        } else if (step === 2) {
            if (level) {
                if (dur >= p.te_long * 2) {
                    if (bitCount >= p.min_bits) {
                        return {
                            proto: p.name, bits: bitCount, dataHi: dataHi, dataLo: dataLo,
                            serial: (dataLo >>> 16) & 0xFFFFFF, button: (dataLo >>> 8) & 0xFF,
                            btnName: getButtonName(p.name, (dataLo >>> 8) & 0xFF),
                            counter: dataLo & 0xFF, crcOk: true
                        };
                    }
                    step = 0;
                } else { teLast = dur; step = 3; }
            } else { step = 0; }
        } else if (step === 3) {
            if (!level) {
                if (durMatch(teLast, p.te_short, p.te_delta) && durMatch(dur, p.te_long, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = (dataLo << 1) >>> 0;
                    bitCount++; step = 2;
                } else if (durMatch(teLast, p.te_long, p.te_delta) && durMatch(dur, p.te_short, p.te_delta)) {
                    dataHi = (dataHi << 1) | (dataLo >>> 31);
                    dataLo = ((dataLo << 1) | 1) >>> 0;
                    bitCount++; step = 2;
                } else { step = 0; }
            } else { step = 0; }
        }
    }
    return null;
}

// ============================================================================
// RAW DATA PARSING
// ============================================================================

function parseRaw(str) {
    var pulses = [];
    var num = "";
    for (var i = 0; i <= str.length; i++) {
        var c = i < str.length ? str.charAt(i) : " ";
        if (c === "-" || (c >= "0" && c <= "9")) { num += c; }
        else if (num.length > 0) {
            var v = parseInt(num, 10);
            if (v !== 0) pulses.push(v);
            num = "";
        }
    }
    return pulses;
}

function extractRawData(content) {
    var idx = content.indexOf("RAW_Data:");
    if (idx < 0) return null;
    var start = idx + 9;
    var end = content.indexOf("\n", start);
    if (end < 0) end = content.length;
    return content.substring(start, end);
}

function extractFrequency(content) {
    var idx = content.indexOf("Frequency:");
    if (idx < 0) return null;
    var start = idx + 10;
    var end = content.indexOf("\n", start);
    if (end < 0) end = content.length;
    var freqStr = content.substring(start, end).trim();
    var freqHz = parseInt(freqStr, 10);
    if (freqHz > 0) {
        return freqHz / 1000000;  // Convert Hz to MHz
    }
    return null;
}

function tryDecode(pulses) {
    var result;
    result = decodeKiaV0(pulses);
    if (result) return result;
    result = decodeKiaV1(pulses);
    if (result) return result;
    result = decodeKiaV2(pulses);
    if (result) return result;
    result = decodeKiaV3V4(pulses);
    if (result) return result;
    result = decodeStarLine(pulses);
    if (result) return result;
    result = decodeScherKhan(pulses);
    if (result) return result;
    result = decodeSubaru(pulses);
    if (result) return result;
    result = decodeFiatV0(pulses);
    if (result) return result;
    result = decodeChrysler(pulses);
    if (result) return result;
    result = decodeGenericPWM(pulses, PROTO_FORD);
    if (result) return result;
    result = decodeGenericPWM(pulses, PROTO_SUZUKI);
    if (result) return result;
    return null;
}

// ============================================================================
// SAVE AND TRANSMIT
// ============================================================================

var saveCounter = 0;
var loadedFiles = [];
var loadFileIndex = 0;

// ============================================================================
// LOAD SIGNAL
// ============================================================================

function scanForFiles() {
    loadedFiles = [];
    // Try to list .sub files from common directories
    var dirs = ["/", "/BruceRF/", "/subghz/"];
    
    for (var d = 0; d < dirs.length; d++) {
        try {
            var files = storage.readdir(dirs[d]);
            if (files && files.length) {
                for (var i = 0; i < files.length; i++) {
                    var fname = files[i];
                    if (fname && fname.length > 4) {
                        var ext = fname.substring(fname.length - 4).toLowerCase();
                        if (ext === ".sub") {
                            loadedFiles.push(dirs[d] + fname);
                        }
                    }
                }
            }
        } catch (e) {
            // Directory doesn't exist or can't be read
        }
    }
    return loadedFiles.length;
}

function loadAndDecodeFile(filepath) {
    drawMessage("Loading...\n" + filepath, YELLOW);
    
    try {
        var content = storage.read(filepath);
        if (!content || content.length < 20) {
            drawMessage("File empty or\ntoo small!", RED);
            delay(1500);
            return false;
        }
        
        // Extract frequency from file
        var fileFreq = extractFrequency(content);
        if (fileFreq) {
            frequency = fileFreq;
            subghz.setFrequency(frequency);
        }
        
        // Extract RAW_Data from file
        var rawStr = extractRawData(content);
        if (!rawStr || rawStr.length < 10) {
            drawMessage("No RAW_Data found\nin file!", RED);
            delay(1500);
            return false;
        }
        
        // Parse and decode
        var pulses = parseRaw(rawStr);
        if (pulses.length < 20) {
            drawMessage("Not enough data\nto decode!", RED);
            delay(1500);
            return false;
        }
        
        var result = tryDecode(pulses);
        if (result) {
            lastResult = result;
            lastRawData = rawStr;
            resultMenuIndex = 0;
            appState = "result";
            drawResult(result);
            delay(300);
            return true;
        } else {
            drawMessage("Could not decode\nprotocol!", RED);
            delay(1500);
            return false;
        }
    } catch (e) {
        drawMessage("Error reading file!", RED);
        delay(1500);
        return false;
    }
}

function drawLoadMenu() {
    clearScreen();
    setTextSize(2); setTextColor(CYAN);
    drawString("Load Signal", 10, 5);
    setTextSize(1);
    
    if (loadedFiles.length === 0) {
        setTextColor(RED);
        drawString("No .sub files found!", 10, 35);
        setTextColor(WHITE);
        drawString("Save a signal first,", 10, 55);
        drawString("or copy .sub files to", 10, 70);
        drawString("SD card root.", 10, 85);
    } else {
        setTextColor(WHITE);
        drawString("Found " + loadedFiles.length + " file(s)", 10, 30);
        
        // Show current file
        var y = 50;
        var startIdx = Math.max(0, loadFileIndex - 2);
        var endIdx = Math.min(loadedFiles.length, startIdx + 5);
        
        for (var i = startIdx; i < endIdx; i++) {
            var fname = loadedFiles[i];
            // Shorten filename for display
            if (fname.length > 28) {
                fname = ".." + fname.substring(fname.length - 26);
            }
            
            if (i === loadFileIndex) {
                drawFillRect(5, y - 2, screenWidth - 10, 14, GRAY);
                setTextColor(CYAN);
            } else {
                setTextColor(WHITE);
            }
            drawString(fname, 10, y);
            y += 16;
        }
    }
    
    setTextColor(YELLOW);
    drawString("[PREV/NEXT] [SEL] Load [ESC]", 5, screenHeight - 12);
}

function handleLoadMenu() {
    if (getEscPress()) {
        appState = "menu";
        drawMenu();
        return;
    }
    
    if (loadedFiles.length === 0) {
        return;
    }
    
    if (getPrevPress()) {
        loadFileIndex--;
        if (loadFileIndex < 0) loadFileIndex = loadedFiles.length - 1;
        drawLoadMenu();
        delay(150);
    }
    if (getNextPress()) {
        loadFileIndex++;
        if (loadFileIndex >= loadedFiles.length) loadFileIndex = 0;
        drawLoadMenu();
        delay(150);
    }
    if (getSelPress()) {
        delay(200);
        if (loadAndDecodeFile(loadedFiles[loadFileIndex])) {
            // Successfully loaded and decoded - now in result state
        } else {
            drawLoadMenu();
        }
    }
}

function saveSignal() {
    if (!lastResult || !lastRawData) {
        drawMessage("No signal to save!", RED);
        delay(1500);
        return;
    }
    
    drawMessage("Saving signal...", YELLOW);
    
    var r = lastResult;
    saveCounter++;
    
    // Create filename - use counter since Date.now may not work
    var protoName = r.proto.replace(/[\s\/]/g, "_");
    var filename = "pp_" + protoName + "_" + saveCounter + ".sub";
    
    // Build file content
    var content = "Filetype: Bruce SubGhz File\n";
    content += "Version: 1\n";
    content += "Frequency: " + Math.floor(frequency * 1000000) + "\n";
    content += "Preset: FuriHalSubGhzPresetOok650Async\n";
    content += "Protocol: RAW\n";
    content += "# ProtoPirate Decoded: " + r.proto + "\n";
    content += "# Serial: " + toHex(r.serial, 7) + " Button: " + r.btnName + "\n";
    content += "# Counter: " + toHex(r.counter, 4) + " CRC: " + (r.crcOk ? "OK" : "FAIL") + "\n";
    content += "RAW_Data: " + lastRawData + "\n";
    
    var saved = false;
    var savePath = "";
    
    // Try multiple paths
    var paths = [
        "/" + filename,
        "/BruceRF/" + filename,
        "/subghz/" + filename
    ];
    
    for (var i = 0; i < paths.length; i++) {
        try {
            storage.write(paths[i], content);
            saved = true;
            savePath = paths[i];
            break;
        } catch (e) {
            // Try next path
        }
    }
    
    if (saved) {
        clearScreen();
        setTextSize(2); setTextColor(GREEN);
        drawString("SAVED!", 10, 5);
        setTextSize(1); setTextColor(WHITE);
        drawString("File: " + filename, 10, 35);
        drawString("Path: " + savePath, 10, 50);
        drawString("Proto: " + r.proto, 10, 70);
        drawString("Serial: " + toHex(r.serial, 7), 10, 85);
        setTextColor(YELLOW);
        drawString("Press any key...", 10, screenHeight - 15);
        delay(500);
        // Wait for button press
        while (!getSelPress() && !getEscPress() && !getPrevPress() && !getNextPress()) {
            delay(50);
        }
    } else {
        drawMessage("Save FAILED!\nCheck SD card", RED);
        delay(2000);
    }
    
    drawResult(lastResult);
}

function transmitSignal() {
    if (!lastResult) {
        drawMessage("No signal to transmit!", RED);
        delay(1000);
        return;
    }
    var txMenuIndex = 0;
    var counterIncrement = 1;
    while (true) {
        clearScreen();
        setTextSize(2); setTextColor(YELLOW);
        drawString("TRANSMIT", 10, 5);
        setTextSize(1); setTextColor(WHITE);
        drawString(lastResult.proto + " - " + lastResult.btnName, 10, 28);
        setTextColor(CYAN);
        drawString("Rolling Code Settings:", 10, 45);
        setTextColor(WHITE);
        drawString("Current Cnt: 0x" + toHex(lastResult.counter, 4), 10, 60);
        var newCounter = (lastResult.counter + counterIncrement) & 0xFFFF;
        drawString("New Counter: 0x" + toHex(newCounter, 4), 10, 74);
        drawString("Increment: +" + counterIncrement, 10, 88);
        var y = 105;
        var txOpts = ["Inc +1", "Inc +10", "Inc +100", "SEND", "Back"];
        for (var i = 0; i < txOpts.length; i++) {
            if (i === txMenuIndex) {
                drawFillRect(5, y - 2, screenWidth - 10, 13, GRAY);
                setTextColor(CYAN);
            } else { setTextColor(WHITE); }
            drawString(txOpts[i], 15, y);
            y += 14;
        }
        setTextColor(YELLOW);
        drawString("[PREV/NEXT] [SEL]", 5, screenHeight - 10);
        delay(100);
        if (getEscPress()) { drawResult(lastResult); return; }
        if (getPrevPress()) { txMenuIndex--; if (txMenuIndex < 0) txMenuIndex = 4; }
        if (getNextPress()) { txMenuIndex++; if (txMenuIndex > 4) txMenuIndex = 0; }
        if (getSelPress()) {
            if (txMenuIndex === 0) { counterIncrement = 1; }
            else if (txMenuIndex === 1) { counterIncrement = 10; }
            else if (txMenuIndex === 2) { counterIncrement = 100; }
            else if (txMenuIndex === 3) {
                doRollingCodeTransmit(newCounter);
                drawResult(lastResult);
                return;
            }
            else if (txMenuIndex === 4) { drawResult(lastResult); return; }
        }
    }
}

function doRollingCodeTransmit(newCounter) {
    clearScreen();
    setTextSize(2); setTextColor(YELLOW);
    drawString("TX ROLLING", 10, 5);
    setTextSize(1); setTextColor(WHITE);
    drawString("Building signal...", 10, 30);
    var r = lastResult;
    var dataHi = r.dataHi & 0x0F000000;
    var dataLo = 0;
    dataHi |= ((newCounter >>> 8) & 0xFF) << 16;
    dataHi |= (newCounter & 0xFF) << 8;
    dataHi |= (r.serial >>> 20) & 0xFF;
    dataLo |= ((r.serial & 0xFFFFF) << 12) >>> 0;
    dataLo |= ((r.button & 0x0F) << 8);
    var crcBytes = [
        (dataHi >>> 16) & 0xFF, (dataHi >>> 8) & 0xFF, dataHi & 0xFF,
        (dataLo >>> 24) & 0xFF, (dataLo >>> 16) & 0xFF, (dataLo >>> 8) & 0xFF
    ];
    var newCrc = kiaCrc8(crcBytes);
    dataLo |= newCrc;
    drawString("New Key: " + toHex(dataHi, 8) + toHex(dataLo, 8), 10, 45);
    drawString("Counter: 0x" + toHex(newCounter, 4), 10, 60);
    drawString("CRC: 0x" + toHex(newCrc, 2), 10, 75);
    setTextColor(RED);
    drawString("Transmitting...", 10, 95);
    drawString("[ESC] to stop", 10, 110);
    setLongPress(true);
    var freqHz = Math.floor(frequency * 1000000);
    var hexData = toHex(dataHi, 8) + toHex(dataLo, 8);
    for (var burst = 0; burst < 3; burst++) {
        if (getEscPress()) break;
        setTextColor(CYAN);
        drawFillRect(10, 125, 80, 14, BLACK);
        drawString("TX: " + (burst + 1) + "/3", 10, 125);
        subghz.transmit(hexData, freqHz, 250, 5);
        delay(150);
    }
    setLongPress(false);
    lastResult.counter = newCounter;
    lastResult.dataHi = dataHi;
    lastResult.dataLo = dataLo;
    drawMessage("TX Complete!\nCounter: 0x" + toHex(newCounter, 4), GREEN);
    delay(1500);
}

function drawMessage(msg, col) {
    clearScreen();
    setTextSize(1); setTextColor(col);
    drawString(msg, 10, screenHeight / 2 - 10);
}

// ============================================================================
// DRAWING
// ============================================================================

function clearScreen() { drawFillRect(0, 0, screenWidth, screenHeight, BLACK); }

function drawMenu() {
    clearScreen();
    setTextSize(2); setTextColor(CYAN);
    drawString("ProtoPirate", 10, 5);
    setTextSize(1); setTextColor(WHITE);
    drawString("Car Key Decoder v2.1", 10, 28);
    var y = 50;
    for (var i = 0; i < menuItems.length; i++) {
        if (i === menuIndex) {
            drawFillRect(5, y - 2, screenWidth - 10, 16, GRAY);
            setTextColor(CYAN);
        } else { setTextColor(WHITE); }
        drawString(menuItems[i], 15, y);
        y += 20;
    }
    setTextColor(YELLOW);
    drawString("[PREV/NEXT] [SEL] OK", 5, screenHeight - 12);
}

function drawReceive() {
    clearScreen();
    setTextSize(2); setTextColor(CYAN);
    drawString("Receiving", 10, 5);
    setTextSize(1); setTextColor(WHITE);
    drawString("Freq: " + frequency + " MHz", 10, 30);
    setTextColor(YELLOW);
    drawString("Waiting for signal...", 10, 50);
    setTextColor(WHITE);
    drawString("Press car key fob button", 10, 70);
    setTextColor(YELLOW);
    drawString("[ESC] Back", 10, screenHeight - 12);
}

function drawResult(r) {
    clearScreen();
    setTextSize(2); setTextColor(GREEN);
    drawString("DECODED!", 10, 5);
    setTextSize(1); setTextColor(CYAN);
    drawString(r.proto + " " + r.bits + "-bit @ " + frequency + "MHz", 10, 28);
    setTextColor(WHITE);
    var y = 42;
    drawString("Key: " + toHex(r.dataHi, 8) + toHex(r.dataLo, 8), 10, y); y += 12;
    drawString("Sn:" + toHex(r.serial, 7) + " Btn:" + r.btnName, 10, y); y += 12;
    drawString("Cnt:0x" + toHex(r.counter, 4), 10, y);
    if (r.crcOk) { setTextColor(GREEN); drawString(" CRC:OK", 80, y); }
    else { setTextColor(RED); drawString(" CRC:FAIL", 80, y); }
    y = screenHeight - 55;
    var opts = ["Transmit", "Save", "Continue"];
    for (var i = 0; i < opts.length; i++) {
        if (i === resultMenuIndex) {
            drawFillRect(5, y - 2, screenWidth - 10, 14, GRAY);
            setTextColor(CYAN);
        } else { setTextColor(WHITE); }
        drawString(opts[i], 15, y);
        y += 16;
    }
    setTextColor(YELLOW);
    drawString("[PREV/NEXT] [SEL] OK", 5, screenHeight - 10);
}

function drawInfo() {
    clearScreen();
    setTextSize(2); setTextColor(CYAN);
    drawString("Protocols", 10, 5);
    setTextSize(1); setTextColor(WHITE);
    var y = 28;
    drawString("Kia V0/V1/V2/V3/V4", 10, y); y += 10;
    drawString("Ford V0, Suzuki", 10, y); y += 10;
    drawString("StarLine (64-bit)", 10, y); y += 10;
    drawString("Scher-Khan (35-51 bit)", 10, y); y += 10;
    drawString("Subaru (64-bit PWM)", 10, y); y += 10;
    drawString("Fiat V0 (64-bit Man)", 10, y); y += 10;
    drawString("Chrysler/Jeep (315MHz)", 10, y);
    setTextColor(YELLOW);
    drawString("[ESC] Back", 10, screenHeight - 12);
}

function drawFreqSelect() {
    clearScreen();
    setTextSize(2); setTextColor(CYAN);
    drawString("Frequency", 10, 5);
    setTextSize(1); setTextColor(WHITE);
    drawString("Select operating frequency:", 10, 30);
    var y = 55;
    var freqLabels = ["315.00 MHz (US Chrysler)", "433.92 MHz (EU/Asia)", "868.35 MHz (EU)"];
    for (var i = 0; i < freqOptions.length; i++) {
        if (i === freqIndex) {
            drawFillRect(5, y - 2, screenWidth - 10, 16, GRAY);
            setTextColor(CYAN);
        } else { setTextColor(WHITE); }
        drawString(freqLabels[i], 15, y);
        y += 20;
    }
    setTextColor(GREEN);
    drawString("Current: " + frequency + " MHz", 10, 125);
    setTextColor(YELLOW);
    drawString("[PREV/NEXT] [SEL] Set [ESC] Back", 5, screenHeight - 12);
}

// ============================================================================
// STATE HANDLERS
// ============================================================================

function handleMenu() {
    if (getPrevPress()) { menuIndex--; if (menuIndex < 0) menuIndex = menuItems.length - 1; drawMenu(); }
    if (getNextPress()) { menuIndex++; if (menuIndex >= menuItems.length) menuIndex = 0; drawMenu(); }
    if (getSelPress()) {
        if (menuIndex === 0) { setLongPress(true); appState = "receive"; drawReceive(); }
        else if (menuIndex === 1) { 
            drawMessage("Scanning for files...", YELLOW);
            scanForFiles();
            loadFileIndex = 0;
            appState = "load"; 
            drawLoadMenu(); 
        }
        else if (menuIndex === 2) { appState = "freq"; drawFreqSelect(); }
        else if (menuIndex === 3) { appState = "info"; drawInfo(); }
        else if (menuIndex === 4) { appState = "exit"; }
    }
}

function handleFreqSelect() {
    if (getEscPress()) { appState = "menu"; drawMenu(); return; }
    if (getPrevPress()) { freqIndex--; if (freqIndex < 0) freqIndex = freqOptions.length - 1; drawFreqSelect(); }
    if (getNextPress()) { freqIndex++; if (freqIndex >= freqOptions.length) freqIndex = 0; drawFreqSelect(); }
    if (getSelPress()) {
        frequency = freqOptions[freqIndex];
        subghz.setFrequency(frequency);
        drawMessage("Frequency set to\n" + frequency + " MHz", GREEN);
        delay(1000);
        appState = "menu";
        drawMenu();
    }
}

function handleReceive() {
    if (getEscPress()) { setLongPress(false); appState = "menu"; drawMenu(); return; }
    var rawContent = subghz.readRaw(1);
    if (getEscPress()) { setLongPress(false); appState = "menu"; drawMenu(); return; }
    if (rawContent && rawContent.length > 10) {
        // Debug: show what we received
        setLongPress(false);
        clearScreen();
        setTextSize(1); setTextColor(CYAN);
        drawString("RAW RECEIVED:", 10, 5);
        setTextColor(WHITE);
        drawString("Len: " + rawContent.length, 10, 18);
        // Show first 100 chars
        var preview = rawContent.substring(0, 80);
        drawString(preview, 5, 32);
        var preview2 = rawContent.substring(80, 160);
        if (preview2) drawString(preview2, 5, 45);
        setTextColor(YELLOW);
        drawString("[SEL] Continue [ESC] Menu", 5, screenHeight - 12);
        while (true) {
            if (getEscPress()) { appState = "menu"; drawMenu(); return; }
            if (getSelPress()) { setLongPress(true); break; }
            delay(50);
        }
        
        var rawStr = extractRawData(rawContent);
        // If no RAW_Data found, try using content directly
        if (!rawStr && rawContent.indexOf(" ") > 0) {
            rawStr = rawContent;
        }
        if (rawStr && rawStr.length > 10) {
            var pulses = parseRaw(rawStr);
            if (pulses.length > 20) {
                var result = tryDecode(pulses);
                if (result) {
                    setLongPress(false);
                    lastResult = result;
                    lastRawData = rawStr;
                    resultMenuIndex = 0;
                    appState = "result";
                    drawResult(result);
                    // Clear any pending button presses and give user time to see result
                    delay(500);
                    getPrevPress(); getNextPress(); getSelPress(); getEscPress();
                    return;
                } else {
                    // Signal captured but protocol not recognized
                    // Store raw data so user can still save it
                    lastRawData = rawStr;
                    setLongPress(false);
                    
                    clearScreen();
                    setTextSize(1); setTextColor(YELLOW);
                    drawString("Signal captured!", 10, 5);
                    drawString("Pulses: " + pulses.length + " @ " + frequency + "MHz", 10, 18);
                    
                    // Show first few pulse timings for debug
                    setTextColor(WHITE);
                    var debugStr = "";
                    for (var d = 0; d < Math.min(8, pulses.length); d++) {
                        debugStr += pulses[d] + " ";
                    }
                    drawString(debugStr, 10, 32);
                    
                    setTextColor(RED);
                    drawString("Unknown protocol", 10, 50);
                    setTextColor(WHITE);
                    drawString("Freq: " + frequency + " MHz", 10, 65);
                    drawString("Try different frequency", 10, 78);
                    drawString("or press key closer", 10, 91);
                    
                    setTextColor(YELLOW);
                    drawString("[SEL] Retry  [ESC] Menu", 5, screenHeight - 12);
                    
                    // Wait for button press instead of fixed delay
                    while (true) {
                        if (getEscPress()) {
                            appState = "menu";
                            drawMenu();
                            return;
                        }
                        if (getSelPress()) {
                            setLongPress(true);
                            drawReceive();
                            break;
                        }
                        delay(50);
                    }
                    return;
                }
            } else if (pulses.length > 0) {
                // Too few pulses - weak signal
                setTextColor(YELLOW);
                drawFillRect(10, 50, 150, 12, BLACK);
                drawString("Weak: " + pulses.length + " pulses", 10, 50);
            }
        }
    }
}

function handleResult() {
    // Check if we have a valid result to display
    if (!lastResult) {
        appState = "menu";
        drawMenu();
        return;
    }
    if (getEscPress()) { 
        delay(200);
        resultMenuIndex = 0; 
        setLongPress(true); 
        appState = "receive"; 
        drawReceive(); 
        return; 
    }
    if (getPrevPress()) { 
        resultMenuIndex--; 
        if (resultMenuIndex < 0) resultMenuIndex = 2; 
        drawResult(lastResult); 
        delay(150);
    }
    if (getNextPress()) { 
        resultMenuIndex++; 
        if (resultMenuIndex > 2) resultMenuIndex = 0; 
        drawResult(lastResult); 
        delay(150);
    }
    if (getSelPress()) {
        delay(200);
        if (resultMenuIndex === 0) { transmitSignal(); }
        else if (resultMenuIndex === 1) { saveSignal(); }
        else { resultMenuIndex = 0; setLongPress(true); appState = "receive"; drawReceive(); }
    }
}

function handleInfo() { if (getEscPress()) { appState = "menu"; drawMenu(); } }

// ============================================================================
// MAIN
// ============================================================================

clearScreen();
setTextSize(2); setTextColor(CYAN);
drawString("ProtoPirate", 30, screenHeight/2 - 15);
setTextSize(1); setTextColor(WHITE);
drawString("Car Key Decoder v2.1", 25, screenHeight/2 + 10);
delay(1500);

subghz.setFrequency(frequency);
drawMenu();

while (appState !== "exit") {
    if (appState === "menu") handleMenu();
    else if (appState === "receive") handleReceive();
    else if (appState === "result") handleResult();
    else if (appState === "info") handleInfo();
    else if (appState === "freq") handleFreqSelect();
    else if (appState === "load") handleLoadMenu();
    delay(50);
}

clearScreen();
setTextColor(WHITE);
drawString("Goodbye!", screenWidth/2 - 25, screenHeight/2);
delay(800);
