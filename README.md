<p align="center">
  <img src="logo.png" width="128" height="128" alt="ProtoPirate Logo"/>
</p>

<h1 align="center">ProtoPirate</h1>

<p align="center">
  <strong>Car Key Fob Decoder &amp; Emulator for Bruce Firmware</strong><br/>
  <em>16 protocols &bull; 9 emulatable &bull; Pure JavaScript &bull; Full crypto suite</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-3.0.0-blue?style=flat-square" alt="Version"/>
  <img src="https://img.shields.io/badge/protocols-16-green?style=flat-square" alt="Protocols"/>
  <img src="https://img.shields.io/badge/emulatable-9-orange?style=flat-square" alt="Emulatable"/>
  <img src="https://img.shields.io/badge/platform-Bruce_1.4+-purple?style=flat-square" alt="Platform"/>
  <img src="https://img.shields.io/badge/device-T--Embed_CC1101-red?style=flat-square" alt="Device"/>
  <img src="https://img.shields.io/badge/language-JavaScript-yellow?style=flat-square" alt="Language"/>
</p>

---

## Overview

ProtoPirate is a full-featured car key fob signal decoder and emulator written in pure JavaScript for **Bruce Firmware 1.4+**. Originally ported from the ProtoPirate C application (Flipper Zero), it achieves **full feature parity** including emulate mode with counter advance, button remapping, and protocol-aware signal re-encoding.

Optimized for the **Lilygo T-Embed CC1101** (320×170 display), it also works on other CC1101-based devices with a compatible Bruce JS interpreter.

---

## Features

| Feature | Description |
|---------|-------------|
| **Live RF Capture** | Real-time signal capture and decoding via CC1101 radio |
| **16 Protocol Decoders** | Auto-detect and decode car key fob signals |
| **Emulate Mode** | Counter advance + button remapping + signal re-encoding (9 protocols) |
| **Signal Encoders** | PWM, Manchester, PSA Manchester, VAG T2 Manchester |
| **Full Crypto Suite** | KeeLoq, TEA, VAG TEA, PSA XOR, YEK — all in pure JS |
| **File Manager** | Browse, load, and decode `.sub` files from SD card |
| **History** | Rolling buffer of last 20 decoded signals |
| **Timing Analyzer** | Inspect raw pulse timing data |
| **Auto-Save** | Automatic saving of decoded signals |
| **Frequency Selection** | 315 MHz (US), 433.92 MHz (EU/Asia), 868.35 MHz (EU) |
| **Preset Selection** | AM650 / AM270 modulation presets |
| **TX Burst Config** | Configurable burst count: 1×, 3×, 5×, 10× |
| **CRC Validation** | Per-protocol CRC verification (Kia V0/V1/V2, Ford, PSA) |
| **Save Signals** | Export to `.sub` files compatible with Bruce/Flipper |

---

## Supported Protocols

### Full Emulate (Counter Advance + Re-encoding) — 9 Protocols

| # | Protocol | Bits | Encoding | CRC / Crypto | Rebuild Function |
|---|----------|------|----------|--------------|------------------|
| 1 | **Kia V0** | 61 | PWM | CRC8 (poly 0x7F) | `rebuildKiaV0()` |
| 2 | **Kia V1** | 57 | Manchester | CRC4 | `rebuildKiaV1()` |
| 3 | **Kia V2** | 53 | Manchester | CRC4 | `rebuildKiaV2()` |
| 4 | **Ford V0** | 80 | Manchester | Matrix CRC | `rebuildFordV0()` |
| 5 | **Subaru** | 64 | PWM | — | `rebuildSubaru()` |
| 6 | **Suzuki** | 64 | PWM | — | `rebuildSuzuki()` |
| 7 | **Chrysler** | 64 | PWM | — | `rebuildChrysler()` |
| 8 | **PSA** (mode 0x23) | 96 | PSA Manchester | XOR encrypt + checksum | `rebuildPSA()` |
| 9 | **VAG T2 TEA** | 80 | VAG Manchester | TEA encrypt | `rebuildVAGT2()` |

### Decode + Raw Replay — 7 Protocols

| # | Protocol | Bits | Encoding | Encryption | Reason |
|---|----------|------|----------|------------|--------|
| 10 | **Kia V3/V4** | 68 | PWM | KeeLoq | Manufacturer key required |
| 11 | **Kia V5** | 67 | Manchester | Mixer/YEK | Key required |
| 12 | **Kia V6** | 144 | Manchester | AES-128 | Key required |
| 13 | **StarLine** | 64 | PWM | KeeLoq | Manufacturer key required |
| 14 | **Scher-Khan** | 35–51 | PWM | Proprietary | Unknown algorithm |
| 15 | **Fiat V0** | 71 | Manchester | KeeLoq | Manufacturer key required |
| 16 | **VAG T1/T3/T4** | 80 | Manchester | AUT64 | Keystore keys required |

> All 16 protocols verified against **KAT** (Rust) and original **ProtoPirate** (C) reference implementations.

---

## Emulate Mode

After decoding a signal, select **Emulate** to enter protocol-aware transmission mode:

1. **Button remapping** — select Lock / Unlock / Trunk / Panic per protocol
2. **Counter advance** — auto-increment counter (+1 per TX)
3. **Signal re-encoding** — rebuild signal with new button/counter values
4. **CRC / Crypto recomputation** — recalculate CRC or re-encrypt as needed
5. **Transmit** — write temp `.sub` file and send via `subghz.transmitFile()`

### Button Remapping per Protocol

| Protocol | Lock | Unlock | Boot/Trunk | Panic |
|----------|------|--------|------------|-------|
| Kia | 0x1 | 0x2 | 0x3 | 0x4 |
| Ford | 0x1 | 0x2 | 0x4 | 0x8 |
| Suzuki | 0x3 | 0x4 | 0x2 | 0x1 |
| Subaru | 0x1 | 0x2 | 0x3 | 0x4 |
| Chrysler | 0x1 | 0x2 | 0x4 | 0x8 |
| VAG | 0x20 | 0x10 | 0x40 | — |
| StarLine | 0x1 | 0x2 | 0x3 | 0x4 |
| PSA | 0x1 | 0x2 | 0x4 | — |
| Fiat | 0x2 | 0x1 | 0x4 | — |

---

## Crypto Primitives

All implemented in pure JavaScript — no native modules required:

| Algorithm | Functions | Used By |
|-----------|----------|---------|
| **TEA** (32 rounds) | `teaEncrypt()` / `teaDecrypt()` | PSA (BF keys) |
| **VAG TEA** variant | `vagTeaEncrypt()` / `vagTeaDecrypt()` | VAG T2 |
| **PSA XOR** | `psaXorEncrypt()` / `psaXorDecrypt()` | PSA mode 0x23 |
| **PSA Checksum** | `psaChecksum()` | PSA validation |
| **KeeLoq** (528 rounds) | `keeloqEncrypt()` / `keeloqDecrypt()` | Kia V3/V4, StarLine, Fiat |
| **KeeLoq Normal Learning** | `keeloqNormalLearning()` | Device key derivation |
| **YEK** (bit reversal) | `computeYEK()` | Kia V5 |
| **Key Reversal** | `reverseKey64()` | StarLine, Kia V3/V4 |
| **CRC8** (poly 0x7F) | `kiaCrc8()` | Kia V0 |
| **CRC4** | `kiaV1Crc4()` / `kiaV2CalcCrc()` | Kia V1, Kia V2 |
| **Ford Matrix CRC** | `fordCalcCrc()` | Ford V0 |

---

## Installation

### From Bruce App Store (Recommended)

Install directly from the **Bruce App Store** on your device.

### Manual — SD Card

Copy `ProtoPirate_6.js` to your SD card in one of these paths:

```
/BruceJS/RF/ProtoPirate.js
```

Or alternatively:
- `/scripts/`
- `/BruceScripts/`

Then on your device: **Others** → **JS Interpreter** → select the file.

### Manual — LittleFS

1. Connect device via USB
2. Upload `ProtoPirate_6.js` to internal storage
3. Run from **Others** → **JS Interpreter**

---

## Usage

### Controls

| Button | Action |
|--------|--------|
| **PREV** (↑) | Navigate up / Previous option |
| **NEXT** (↓) | Navigate down / Next option |
| **SEL** (●) | Select / Confirm |
| **ESC** (←) | Back / Exit |

### Main Menu

| Menu Item | Description |
|-----------|-------------|
| **Receive** | Start live RF capture at selected frequency |
| **Load SUB** | Browse and decode `.sub` files from SD card |
| **History** | View last 20 decoded signals |
| **Timing** | Analyze raw pulse timing data |
| **Settings** | Configure frequency, sensitivity, TX burst, preset, auto-save |
| **Protocols** | Scrollable protocol info page |
| **Exit** | Return to Bruce menu |

### Settings

| Setting | Options | Default |
|---------|---------|---------|
| Frequency | 315.00 / 433.92 / 868.35 MHz | 433.92 MHz |
| Sensitivity | 5 / 10 / 20 / 30 min pulses | 10 |
| Pulse Filter | 5 / 50 / 100 / 500 ms max | 50 ms |
| TX Burst | 1× / 3× / 5× / 10× | 3× |
| Preset | AM650 / AM270 | AM650 |
| Auto-Save | ON / OFF | OFF |

### Receiving Signals

1. Select **Receive** from the main menu
2. Press your car key fob near the CC1101 antenna
3. Wait for signal decode (3-second blocking timeout per attempt)
4. Decoded result shows:
   - Protocol name and bit count
   - Full key data (hex)
   - Serial number
   - Button name (Lock / Unlock / Trunk / Panic)
   - Rolling counter value
   - CRC status (OK / FAIL)
   - Encryption status

### After Decoding

| Option | Description |
|--------|-------------|
| **Emulate** | Enter emulate mode (counter advance + button remapping) |
| **Transmit** | Raw replay of captured signal |
| **Save** | Save signal to `.sub` file |
| **Continue** | Return to receive mode |

---

## Signal Encoders

### PWM Encoder (`encodePWM`)
- Preamble: N pairs of `te_short` high/low
- Start bit: `te_long` high + `te_long` low
- Data: bit 0 → short/short, bit 1 → long/long (MSB first)
- Multi-burst support with configurable gap

### Manchester Encoder (`encodeManchester`)
- Preamble: N pairs of `te_long` high/low
- Start: `te_long` high + `te_short` low
- Data: bit 1 → short high + short low, bit 0 → short low + short high
- Automatic edge coalescing

### PSA Manchester Encoder (`encodePSAManchester`)
- 80-pair preamble @ 250µs
- Transition: LOW 250µs + HIGH 500µs + LOW 250µs
- 64-bit key1 + 16-bit key2 Manchester MSB first
- 10 burst repeats, 10ms inter-burst gap

### VAG T2 Manchester Encoder (`encodeVAGT2Manchester`)
- 220-pair preamble @ 300µs
- Sync: LOW 300µs + HIGH 300µs
- Prefix 0xAF1C (16-bit, NOT inverted)
- Key1 (64-bit) + Key2 (16-bit) INVERTED Manchester MSB first
- 10 burst repeats, 10ms inter-burst gap

---

## Saved File Format

Files are saved to SD card:
```
/protopirate_Kia_V0_1708142400000.sub
```

Example contents:
```
Filetype: Bruce SubGhz File
Version: 1
Frequency: 433920000
Preset: FuriHalSubGhzPresetOok650Async
Protocol: RAW
# ProtoPirate Decoded: Kia V0
# Serial: 1234567 Button: Lock
# Counter: 1234 CRC: OK
RAW_Data: 250 -250 250 -250 ...
```

---

## Technical Details

### Kia V0 Data Structure (61 bits)

```
┌─────────┬──────────┬──────────┬────────┬───────┐
│ Prefix  │ Counter  │  Serial  │ Button │  CRC  │
│  4 bit  │  16 bit  │  28 bit  │ 4 bit  │ 8 bit │
└─────────┴──────────┴──────────┴────────┴───────┘
```

- **Prefix**: Header bits (preserved from capture)
- **Counter**: Rolling code (0x0000–0xFFFF)
- **Serial**: Unique fob identifier
- **Button**: 0x01=Lock, 0x02=Unlock, 0x03=Trunk, 0x04=Panic
- **CRC**: CRC-8 with polynomial 0x7F

### CRC-8 Implementation

```javascript
function kiaCrc8(bytes) {
    var crc = 0;
    for (var i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (var j = 0; j < 8; j++) {
            if (crc & 0x80) crc = ((crc << 1) ^ 0x7F) & 0xFF;
            else crc = (crc << 1) & 0xFF;
        }
    }
    return crc;
}
```

---

## Known Limitations

| # | Limitation | Reason |
|---|-----------|--------|
| 1 | Encrypted protocol emulation (KeeLoq/AES/AUT64) | Requires manufacturer keys |
| 2 | PSA mode 0x36 emulation | TEA brute force infeasible on ESP32 |
| 3 | VAG T1 AUT64 emulation | Requires keystore keys |
| 4 | Frequency hopping | Bruce JS API is synchronous/blocking |
| 5 | `subghz.transmit()` limited to 24-bit keys | Uses `transmitFile()` instead |
| 6 | MAX_PULSES = 4096 | Adequate for car fob signals (60–200 pulses) |
| 7 | Hold-to-transmit | `transmitFile` is blocking; one TX per button press |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't exit receive mode | Hold **ESC** for ~1 second (3s blocking timeout) |
| No signals detected | Verify frequency (433.92 MHz default), move antenna closer |
| CRC always fails | Try multiple captures; signal may be partial |
| Transmit doesn't work | Counter may be outside acceptance window; try +10 / +100 |
| App crashes | Restart Bruce; avoid rapid repeated operations (ESP32 memory) |

---

## Legal Notice

> **WARNING**: This software is for **educational and authorized security research only**.
>
> - Intercepting or transmitting car key signals without authorization may be **illegal**
> - Only use on vehicles you **own** or have **explicit written permission** to test
> - You are solely responsible for complying with all applicable laws
> - The authors assume no liability for misuse

---

## Credits

### Original ProtoPirate (C / Flipper Zero)
- **RocketGod**, **MMX**, **Leeroy**, **gullradriel**
- The Pirates' Plunder community

### Protocol Research
- **L0rdDiakon**, **YougZ**, **DoobTheGoober**
- **Skorp**, **Slackware**, **Trikk**, **Li0ard**

### Bruce Firmware
- **@pr3y**, **@bmorcelli**, **@IncursioHack**

### JS Port
- Educational adaptation for T-Embed CC1101 with Bruce Firmware
- **@jsauce454**, **@Senape3000**

---

## Community

- **Discord**: [The Pirates' Plunder](https://discord.gg/thepirates)
- **Bruce Firmware**: [GitHub](https://github.com/pr3y/Bruce)
- **Bruce App Store**: [App-Store-Data](https://github.com/BruceDevices/App-Store-Data)

---

## Version History

### v3.0.0 — Full Feature Parity
- **16 protocol decoders** verified against KAT (Rust) and original C reference
- **Emulate mode** with counter advance, button remapping, and signal re-encoding for **9 protocols**
- **PSA emulate** (mode 0x23 XOR re-encoding with checksum brute-force)
- **VAG T2 TEA emulate** (TEA encrypt with VAG variant key)
- **Protocol-specific signal encoders**: PSA Manchester, VAG T2 Manchester
- **Full crypto library**: KeeLoq, TEA, VAG TEA, PSA XOR, PSA Checksum, YEK
- Added Kia V5, Kia V6, PSA, VAG T1/T2/T3/T4 protocol decoders
- Auto-save, scrollable protocol info, timing analyzer
- History system (last 20 signals)
- Multi-line RAW_Data parsing, memory-safe pulse limits (MAX_PULSES = 4096)
- Configurable sensitivity, pulse filter, TX burst count, preset selection
- 8 critical bug fixes (PSA XOR cipher, PSA mode 0x23, VAG T2 fields, Subaru buttons)

### v2.2.0
- Added Load Signal feature — browse and decode `.sub` files from SD card
- Added Chrysler/Jeep protocol decoder (64-bit KeeLoq @ 315 MHz)
- Added frequency selection menu (315/433.92/868.35 MHz)
- UI improvements for multi-frequency support

### v2.0.0
- Added Kia V1, V2, V3/V4 protocol decoders
- Added Subaru and Fiat V0 decoders
- Enhanced Scher-Khan decoder (35–51 bit, MAGIC CODE detection)
- CRC validation for Kia V1/V2

### v1.1.0
- Rolling code transmission with counter increment and CRC recalculation

### v1.0.0
- Initial JS port — multi-protocol decoding, save to `.sub`, basic replay
