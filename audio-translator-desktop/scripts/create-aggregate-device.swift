import CoreAudio
import AudioToolbox
import Foundation

// MARK: - Property getters

func getDeviceName(_ deviceID: AudioDeviceID) -> String {
    var name: CFString = "" as CFString
    var propSize = UInt32(MemoryLayout<CFString>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propSize, &name)
    if status != noErr { return "Unknown" }
    return name as String
}

func getDeviceUID(_ deviceID: AudioDeviceID) -> String {
    var uid: CFString = "" as CFString
    var propSize = UInt32(MemoryLayout<CFString>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propSize, &uid)
    if status != noErr { return "Unknown" }
    return uid as String
}

func getDefaultOutputDevice() -> AudioDeviceID? {
    var deviceID = AudioDeviceID()
    var propSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address, 0, nil, &propSize, &deviceID
    )
    if status != noErr { return nil }
    return deviceID
}

func getAllAudioDevices() -> [AudioDeviceID] {
    var propSize = UInt32(0)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var status = AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address, 0, nil, &propSize
    )
    if status != noErr { return [] }

    let count = Int(propSize) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: count)
    status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address, 0, nil, &propSize, &devices
    )
    if status != noErr { return [] }
    return devices
}

func getAggregateSubDeviceUIDs(_ deviceID: AudioDeviceID) -> [String] {
    var propSize = UInt32(0)
    // kAudioAggregateDevicePropertyFullSubDeviceList = 'full' (fourCC)
    var address = AudioObjectPropertyAddress(
        mSelector: 1718775916, // kAudioAggregateDevicePropertyFullSubDeviceList
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &propSize)
    if status != noErr { return [] }

    let count = Int(propSize) / MemoryLayout<AudioDeviceID>.size
    var subDevices = [AudioDeviceID](repeating: 0, count: count)
    let status2 = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &propSize, &subDevices)
    if status2 != noErr { return [] }
    return subDevices.map { getDeviceUID($0) }
}

func existingAggregateWithBlackHole() -> AudioDeviceID? {
    for device in getAllAudioDevices() {
        let subs = getAggregateSubDeviceUIDs(device)
        if subs.contains(blackholeUID) && subs.count >= 2 {
            return device
        }
    }
    return nil
}

// MARK: - Main

let args = CommandLine.arguments

guard let blackhole = (getAllAudioDevices().first { getDeviceName($0).lowercased().contains("blackhole") }) else {
    print("ERROR: BlackHole audio device not found. Please install BlackHole first.")
    exit(1)
}

let blackholeUID = getDeviceUID(blackhole)

// Determine target output device: command-line arg, or system default
let targetDevice: AudioDeviceID
if args.count >= 2 {
    let targetName = args[1]
    // Find by name, preferring the output variant (uid ending in :output).
    // Bluetooth devices appear twice with same name — once as input (:input), once as output (:output).
    let matches = getAllAudioDevices().filter {
        getDeviceName($0) == targetName || getDeviceName($0).lowercased() == targetName.lowercased()
    }
    let outputMatch = matches.first { getDeviceUID($0).hasSuffix(":output") }
    guard let found = outputMatch ?? matches.first else {
        print("ERROR: Output device not found: \(targetName)")
        exit(1)
    }
    targetDevice = found
} else {
    guard let defOut = getDefaultOutputDevice() else {
        print("ERROR: Could not determine default output device.")
        exit(1)
    }
    targetDevice = defOut
}

let targetUID = getDeviceUID(targetDevice)
let targetName = getDeviceName(targetDevice)

// Check if an aggregate containing both BlackHole and the target device already exists
if let existing = existingAggregateWithBlackHole() {
    let subs = getAggregateSubDeviceUIDs(existing)
    if subs.contains(targetUID) {
        let name = getDeviceName(existing)
        print("OK:\(existing):already_exists:\(name)")
        exit(0)
    }
    // Existing aggregate has BlackHole but a different output — still usable
    let name = getDeviceName(existing)
    print("OK:\(existing):already_exists:\(name)")
    exit(0)
}

// Check for aggregate by canonical UID
let safeName = targetName.replacingOccurrences(of: " ", with: "-")
    .replacingOccurrences(of: "'", with: "")
    .replacingOccurrences(of: "\"", with: "")
let deviceUIDStr = "com.realtime-translator.aggregate.v2.\(safeName)"
if let existingByUID = (getAllAudioDevices().first { getDeviceUID($0) == deviceUIDStr }) {
    let name = getDeviceName(existingByUID)
    print("OK:\(existingByUID):already_exists:\(name)")
    exit(0)
}

// Create a new multi-output aggregate device matching Audio MIDI Setup.
// Critical: set kAudioAggregateDeviceMainSubDeviceKey to the physical output
// so the aggregate uses its clock (e.g. 44100 Hz for Bluetooth), not BlackHole's 48000 Hz.
let deviceName = "RealTime Translator (\(targetName))" as CFString
let deviceUID = deviceUIDStr as CFString

let desc: [CFString: Any] = [
    kAudioAggregateDeviceNameKey as CFString: deviceName,
    kAudioAggregateDeviceUIDKey as CFString: deviceUID,
    kAudioAggregateDeviceIsStackedKey as CFString: kCFBooleanTrue as CFBoolean,
    kAudioAggregateDeviceMainSubDeviceKey as CFString: targetUID as CFString,
    kAudioAggregateDeviceSubDeviceListKey as CFString: [
        [kAudioSubDeviceUIDKey as CFString: targetUID as CFString],
        [kAudioSubDeviceUIDKey as CFString: blackholeUID as CFString]
    ] as CFArray
]

let cfDesc = desc as CFDictionary
var newDeviceID = AudioDeviceID()

let status = AudioHardwareCreateAggregateDevice(cfDesc, &newDeviceID)
if status != noErr {
    print("ERROR: Failed to create aggregate device. OSStatus: \(status)")
    exit(1)
}

print("OK:\(newDeviceID):created:\(deviceName as String)")
