# ProtoPirate for Bruce Firmware

A JavaScript port of the ProtoPirate car key fob decoder for the **Lilygo T-Embed CC1101** running **Bruce Firmware 1.14+**.

## Features

- **Real-time signal capture and decoding** using the CC1101 radio
- **Enhanced multi-protocol support** - automatically detects and decodes 11+ car key protocols
- **Frequency selection** - switch between 315 MHz, 433.92 MHz, and 868.35 MHz
- **Load saved signals** - browse and decode .sub files from SD card
- **Rolling code transmission** - increment counter, recalculate CRC, and transmit
- **CRC validation** - verifies signal integrity (Kia V0/V1/V2 fully implemented)
- **Save decoded signals** - stores to .sub files compatible with Bruce/Flipper
- **Pure JavaScript** - runs on Bruce's built-in JS interpreter, no compilation needed

## Supported Protocols

| Protocol | Bits | Encoding | Decode | TX Rolling Code |
|----------|------|----------|--------|----------------|
| Kia V0 | 61 | PWM | ✅ | ✅ Full CRC |
| Kia V1 | 57 | Manchester | ✅ | ✅ CRC-4 |
| Kia V2 | 53 | Manchester | ✅ | ✅ CRC-4 |
| Kia V3/V4 | 68 | PWM/KeeLoq | ✅ | ⚠️ Encrypted |
| Ford V0 | 64 | Manchester | ✅ | ⚠️ Decode only |
| Suzuki | 64 | PWM | ✅ | ⚠️ Decode only |
| StarLine | 64 | PWM | ✅ | ⚠️ Decode only |
| Scher-Khan | 35-51 | PWM | ✅ | ⚠️ Decode only |
| Subaru | 64 | PWM | ✅ | ⚠️ Decode only |
| Fiat V0 | 64 | Manchester | ✅ | ⚠️ Decode only |
| Chrysler/Jeep | 64 | PWM/KeeLoq | ✅ | ⚠️ Encrypted |

*More protocols can be added by implementing their CRC algorithms*

## Installation

### Method 1: SD Card (Recommended)

1. Copy `protopirate_bruce.js` to your SD card:
   ```
   /scripts/protopirate_bruce.js
   ```
   Or alternatively:
   - `/BruceScripts/`
   - `/BruceJS/`

2. On your T-Embed CC1101:
   - Navigate to **Others** → **JS Interpreter**
   - Select `protopirate_bruce.js`

### Method 2: LittleFS

1. Connect T-Embed via USB
2. Upload `protopirate_bruce.js` to internal storage
3. Run from **Others** → **JS Interpreter**

## Usage

### Controls

| Button | Action |
|--------|--------|
| **PREV** | Navigate up / Previous option |
| **NEXT** | Navigate down / Next option |
| **SEL** | Select / Confirm |
| **ESC** | Back / Exit |

### Main Menu

- **Receive Signal** - Start capturing at selected frequency
- **Load Signal** - Browse and decode saved .sub files from SD card
- **Set Frequency** - Choose 315 MHz (US), 433.92 MHz (EU/Asia), or 868.35 MHz (EU)
- **Protocol Info** - View supported protocols
- **Exit** - Return to Bruce menu

### Receiving Signals

1. Select **Receive Signal**
2. Press your car key fob near the antenna
3. Wait for signal to be decoded (~1 second timeout per attempt)
4. When decoded, you'll see:
   - Protocol name and bit count
   - Full key data (hex)
   - Serial number
   - Button name (Lock/Unlock/Trunk/Panic)
   - Rolling counter
   - CRC status (OK/FAIL)

### After Decoding - Result Menu

- **Transmit** - Open rolling code TX menu
- **Save** - Save signal to .sub file
- **Continue** - Return to receiving mode

### Rolling Code Transmission

When you select **Transmit**:

1. View current counter value
2. Choose increment amount:
   - **Inc +1** - Add 1 to counter
   - **Inc +10** - Add 10 to counter  
   - **Inc +100** - Add 100 to counter
3. Preview new counter value
4. Select **SEND** to transmit

The system will:
- Rebuild the signal with new counter
- Recalculate CRC (for Kia V0)
- Transmit 3 bursts
- Update stored counter for next TX

## How Rolling Codes Work

```
Capture:    Counter=0x1234, Serial=0x1234567, Button=Lock, CRC=0xAB
                ↓
Increment:  Counter=0x1235 (+1)
                ↓
Rebuild:    Counter=0x1235, Serial=0x1234567, Button=Lock, CRC=0xCD (new!)
                ↓
Transmit:   New valid signal with incremented counter
```

**Why this works:**
- Car receivers accept counters within a "window" (typically +1 to +256 ahead)
- Each TX increments the stored counter
- Subsequent transmissions continue from new counter value

## Saved File Format

Files are saved to SD card root:
```
/protopirate_Kia_V0_1708142400000.sub
```

Contents:
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

## Technical Details

### Kia V0 Data Structure (61 bits)

```
[Prefix 4b][Counter 16b][Serial 28b][Button 4b][CRC 8b]
```

- **Prefix**: Header bits (preserved from capture)
- **Counter**: Rolling code counter (0x0000-0xFFFF)
- **Serial**: Unique fob identifier
- **Button**: 0x01=Lock, 0x02=Unlock, 0x03=Trunk, 0x04=Panic
- **CRC**: CRC-8 with polynomial 0x7F

### CRC Calculation

```javascript
// Kia V0 CRC-8 (polynomial 0x7F)
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

### PWM Encoding

- **Bit 0**: Short pulse + Short gap (250µs + 250µs)
- **Bit 1**: Long pulse + Long gap (500µs + 500µs)
- **Preamble**: 16x short-short pairs
- **Start**: Long-long pair

## Troubleshooting

### Can't exit receive mode
- Hold **ESC** for ~1 second (blocking read has 1s timeout)

### No signals detected
- Verify frequency is 433.92 MHz (default)
- Move antenna closer to key fob
- Check CC1101 connection

### CRC always fails
- Signal may be partially captured
- Try multiple captures
- Some regional variants have different CRC

### Transmit doesn't work on car
- Counter may be outside acceptance window
- Try higher increment (+10, +100)
- Some cars have additional security layers

### App crashes
- Memory limited on ESP32
- Restart Bruce and try again
- Avoid rapid repeated operations

## Legal Notice

⚠️ **WARNING**: This software is for **educational and authorized security research only**.

- Intercepting or transmitting car key signals without authorization may be **illegal**
- Only use on vehicles you **own** or have **explicit written permission** to test
- You are solely responsible for complying with all applicable laws
- The authors assume no liability for misuse

## Credits

### Original ProtoPirate
- RocketGod, MMX, Leeroy, gullradriel
- The Pirates' Plunder community

### Protocol Research
- L0rdDiakon, YougZ, DoobTheGoober
- Skorp, Slackware, Trikk, Li0ard

### Bruce Firmware
- @pr3y, @bmorcelli, @IncursioHack

### JS Port
- Educational adaptation for T-Embed CC1101

## Community

- **Discord**: [The Pirates' Plunder](https://discord.gg/thepirates)
- **Bruce Firmware**: [GitHub](https://github.com/pr3y/Bruce)

## Version History

### v2.1
- Added Load Signal feature - browse and decode .sub files from SD card
- Added Chrysler/Jeep protocol decoder (64-bit KeeLoq @ 315 MHz)
- Added frequency selection menu (315/433.92/868.35 MHz)
- UI improvements for multi-frequency support

### v2.0
- Added Kia V1, V2, V3/V4 protocol decoders
- Added Subaru protocol decoder (64-bit PWM)
- Added Fiat V0 protocol decoder (64-bit Manchester)
- Enhanced Scher-Khan decoder (35-51 bit support, MAGIC CODE detection)
- CRC validation for Kia V1 (CRC-4) and Kia V2
- Improved protocol detection and auto-identification
- UI improvements and version bump

### v1.1
- Added rolling code transmission with counter increment
- CRC recalculation for Kia V0
- Transmit menu with increment options
- Fixed ESC responsiveness in receive mode

### v1.0
- Initial JS port
- Multi-protocol decoding
- Save to .sub file
- Basic replay (raw)
