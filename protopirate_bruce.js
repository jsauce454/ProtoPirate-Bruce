/**
 * ProtoPirate Car Key Decoder for Bruce Firmware 1.14
 * Simplified version following Bruce JS API patterns
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
var menuItems = ["Receive Signal", "Protocol Info", "Exit"];
var appState = "menu";
var lastResult = null;
var lastRawData = "";  // Store raw pulse data for replay
var frequency = 433.92;
var resultMenuIndex = 0;

// Protocol constants
var PROTO_KIA_V0 = { name: "Kia V0", te_short: 250, te_long: 500, te_delta: 100, min_bits: 61 };
var PROTO_FORD = { name: "Ford V0", te_short: 250, te_long: 500, te_delta: 100, min_bits: 64 };
var PROTO_SUZUKI = { name: "Suzuki", te_short: 250, te_long: 500, te_delta: 100, min_bits: 64 };

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

// ============================================================================
// KIA V0 DECODER
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
    
    var btnName = "Unknown";
    if (button === 1) btnName = "Lock";
    else if (button === 2) btnName = "Unlock";
    else if (button === 3) btnName = "Trunk";
    else if (button === 4) btnName = "Panic";
    
    return {
        proto: "Kia V0", bits: bitCount, dataHi: dataHi, dataLo: dataLo,
        serial: serial, button: button, btnName: btnName, counter: counter,
        crcOk: (rxCrc === calcCrc)
    };
}

// ============================================================================
// GENERIC PWM DECODER
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
                            btnName: "Unknown", counter: dataLo & 0xFF, crcOk: true
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

function tryDecode(pulses) {
    var result = decodeKiaV0(pulses);
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

function saveSignal() {
    if (!lastResult || !lastRawData) {
        drawMessage("No signal to save!", RED);
        return;
    }
    
    var r = lastResult;
    var ts = Date.now ? Date.now() : 0;
    var filename = "/protopirate_" + r.proto.replace(/[\s\/]/g, "_") + "_" + ts + ".sub";
    
    var content = "Filetype: Bruce SubGhz File\n";
    content += "Version: 1\n";
    content += "Frequency: " + Math.floor(frequency * 1000000) + "\n";
    content += "Preset: FuriHalSubGhzPresetOok650Async\n";
    content += "Protocol: RAW\n";
    content += "# ProtoPirate Decoded: " + r.proto + "\n";
    content += "# Serial: " + toHex(r.serial, 7) + " Button: " + r.btnName + "\n";
    content += "# Counter: " + toHex(r.counter, 4) + " CRC: " + (r.crcOk ? "OK" : "FAIL") + "\n";
    content += "RAW_Data: " + lastRawData + "\n";
    
    try {
        storage.write(filename, content);
        drawMessage("Saved!\n" + filename, GREEN);
    } catch (e) {
        drawMessage("Save failed!", RED);
    }
    delay(1500);
    drawResult(lastResult);
}

function transmitSignal() {
    if (!lastResult) {
        drawMessage("No signal to transmit!", RED);
        delay(1000);
        return;
    }
    
    // Show TX menu - increment counter options
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
        
        // Menu options
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
        
        // Handle input
        delay(100);
        if (getEscPress()) { drawResult(lastResult); return; }
        if (getPrevPress()) { txMenuIndex--; if (txMenuIndex < 0) txMenuIndex = 4; }
        if (getNextPress()) { txMenuIndex++; if (txMenuIndex > 4) txMenuIndex = 0; }
        if (getSelPress()) {
            if (txMenuIndex === 0) { counterIncrement = 1; }
            else if (txMenuIndex === 1) { counterIncrement = 10; }
            else if (txMenuIndex === 2) { counterIncrement = 100; }
            else if (txMenuIndex === 3) {
                // SEND - build and transmit rolling code
                doRollingCodeTransmit(newCounter);
                drawResult(lastResult);
                return;
            }
            else if (txMenuIndex === 4) { drawResult(lastResult); return; }
        }
    }
}

// Build and transmit a rolling code signal with new counter
function doRollingCodeTransmit(newCounter) {
    clearScreen();
    setTextSize(2); setTextColor(YELLOW);
    drawString("TX ROLLING", 10, 5);
    setTextSize(1); setTextColor(WHITE);
    drawString("Building signal...", 10, 30);
    
    var r = lastResult;
    
    // Rebuild data with new counter and recalculate CRC
    // Kia V0 format: [prefix 4b][counter 16b][serial 28b][button 4b][crc 8b] = 60 bits + 1 start
    var dataHi = r.dataHi & 0x0F000000;  // Preserve prefix bits
    var dataLo = 0;
    
    // Insert counter (bits 40-55)
    dataHi |= ((newCounter >>> 8) & 0xFF) << 16;
    dataHi |= (newCounter & 0xFF) << 8;
    
    // Insert serial (bits 12-39) 
    dataHi |= (r.serial >>> 20) & 0xFF;
    dataLo |= ((r.serial & 0xFFFFF) << 12) >>> 0;
    
    // Insert button (bits 8-11)
    dataLo |= ((r.button & 0x0F) << 8);
    
    // Calculate new CRC
    var crcBytes = [
        (dataHi >>> 16) & 0xFF,
        (dataHi >>> 8) & 0xFF,
        dataHi & 0xFF,
        (dataLo >>> 24) & 0xFF,
        (dataLo >>> 16) & 0xFF,
        (dataLo >>> 8) & 0xFF
    ];
    var newCrc = kiaCrc8(crcBytes);
    dataLo |= newCrc;
    
    drawString("New Key: " + toHex(dataHi, 8) + toHex(dataLo, 8), 10, 45);
    drawString("Counter: 0x" + toHex(newCounter, 4), 10, 60);
    drawString("CRC: 0x" + toHex(newCrc, 2), 10, 75);
    
    // Build PWM waveform
    var waveform = buildKiaWaveform(dataHi, dataLo);
    
    setTextColor(RED);
    drawString("Transmitting...", 10, 95);
    drawString("[ESC] to stop", 10, 110);
    
    // Transmit using rebuilt data
    setLongPress(true);
    var freqHz = Math.floor(frequency * 1000000);
    var hexData = toHex(dataHi, 8) + toHex(dataLo, 8);
    
    for (var burst = 0; burst < 3; burst++) {
        if (getEscPress()) break;
        
        setTextColor(CYAN);
        drawFillRect(10, 125, 80, 14, BLACK);
        drawString("TX: " + (burst + 1) + "/3", 10, 125);
        
        // Transmit with proper timing
        // subghz.transmit(hexData, frequency_hz, te, repeat_count)
        subghz.transmit(hexData, freqHz, 250, 5);
        delay(150);
    }
    setLongPress(false);
    
    // Update lastResult with new counter and data for next TX
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
    drawString("Car Key Decoder", 10, 28);
    
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
    drawString(r.proto + " " + r.bits + "-bit", 10, 28);
    setTextColor(WHITE);
    var y = 42;
    drawString("Key: " + toHex(r.dataHi, 8) + toHex(r.dataLo, 8), 10, y); y += 12;
    drawString("Sn:" + toHex(r.serial, 7) + " Btn:" + r.btnName, 10, y); y += 12;
    drawString("Cnt:0x" + toHex(r.counter, 4), 10, y);
    if (r.crcOk) { setTextColor(GREEN); drawString(" CRC:OK", 80, y); }
    else { setTextColor(RED); drawString(" CRC:FAIL", 80, y); }
    
    // Draw menu options
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
    var y = 30;
    drawString("Kia V0 (61-bit PWM)", 10, y); y += 14;
    drawString("Ford V0 (64-bit)", 10, y); y += 14;
    drawString("Suzuki (64-bit PWM)", 10, y); y += 14;
    drawString("StarLine (64-bit)", 10, y); y += 14;
    setTextColor(YELLOW);
    drawString("[ESC] Back", 10, screenHeight - 12);
}

// ============================================================================
// STATE HANDLERS
// ============================================================================

function handleMenu() {
    if (getPrevPress()) { menuIndex--; if (menuIndex < 0) menuIndex = menuItems.length - 1; drawMenu(); }
    if (getNextPress()) { menuIndex++; if (menuIndex >= menuItems.length) menuIndex = 0; drawMenu(); }
    if (getSelPress()) {
        if (menuIndex === 0) {
            setLongPress(true);  // Buffer key presses during blocking readRaw
            appState = "receive";
            drawReceive();
        }
        else if (menuIndex === 1) { appState = "info"; drawInfo(); }
        else if (menuIndex === 2) { appState = "exit"; }
    }
}

function handleReceive() {
    // Check ESC first - setLongPress buffers key presses during blocking calls
    if (getEscPress()) {
        setLongPress(false);
        appState = "menu";
        drawMenu();
        return;
    }
    
    // Short timeout (1 sec) for more responsive ESC checking
    var rawContent = subghz.readRaw(1);
    
    // Check ESC again after blocking call
    if (getEscPress()) {
        setLongPress(false);
        appState = "menu";
        drawMenu();
        return;
    }
    
    if (rawContent && rawContent.length > 10) {
        var rawStr = extractRawData(rawContent);
        if (rawStr && rawStr.length > 10) {
            var pulses = parseRaw(rawStr);
            if (pulses.length > 20) {
                var result = tryDecode(pulses);
                if (result) {
                    setLongPress(false);
                    lastResult = result;
                    lastRawData = rawStr;  // Store for save/transmit
                    resultMenuIndex = 0;
                    appState = "result";
                    drawResult(result);
                    return;
                }
            }
        }
    }
}

function handleResult() {
    if (getEscPress()) {
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
    }
    if (getNextPress()) {
        resultMenuIndex++;
        if (resultMenuIndex > 2) resultMenuIndex = 0;
        drawResult(lastResult);
    }
    if (getSelPress()) {
        if (resultMenuIndex === 0) {
            // Transmit
            transmitSignal();
        } else if (resultMenuIndex === 1) {
            // Save
            saveSignal();
        } else {
            // Continue receiving
            resultMenuIndex = 0;
            setLongPress(true);
            appState = "receive";
            drawReceive();
        }
    }
}

function handleInfo() {
    if (getEscPress()) { appState = "menu"; drawMenu(); }
}

// ============================================================================
// MAIN
// ============================================================================

clearScreen();
setTextSize(2); setTextColor(CYAN);
drawString("ProtoPirate", 30, screenHeight/2 - 15);
setTextSize(1); setTextColor(WHITE);
drawString("Car Key Decoder v1.0", 25, screenHeight/2 + 10);
delay(1500);

// Set frequency - takes MHz as float, NOT Hz!
subghz.setFrequency(frequency);
drawMenu();

while (appState !== "exit") {
    if (appState === "menu") handleMenu();
    else if (appState === "receive") handleReceive();
    else if (appState === "result") handleResult();
    else if (appState === "info") handleInfo();
    delay(50);
}

clearScreen();
setTextColor(WHITE);
drawString("Goodbye!", screenWidth/2 - 25, screenHeight/2);
delay(800);
