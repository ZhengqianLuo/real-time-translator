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
    guard let found = (getAllAudioDevices().first { getDeviceName($0) == targetName || getDeviceName($0).lowercased() == targetName.lowercased() }) else {
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
let deviceUIDStr = "com.realtime-translator.aggregate.\(safeName)"
if let existingByUID = (getAllAudioDevices().first { getDeviceUID($0) == deviceUIDStr }) {
    let name = getDeviceName(existingByUID)
    print("OK:\(existingByUID):already_exists:\(name)")
    exit(0)
}

// Create a new multi-output aggregate device
let deviceName = "RealTime Translator (\(targetName))" as CFString
let deviceUID = deviceUIDStr as CFString
let stackedKey = kAudioAggregateDeviceIsStackedKey as CFString
let subDeviceListKey = kAudioAggregateDeviceSubDeviceListKey as CFString
let subDeviceUIDKey = kAudioSubDeviceUIDKey as CFString
let subDeviceDriftKey = kAudioSubDeviceDriftCompensationKey as CFString
let nameKey = kAudioAggregateDeviceNameKey as CFString
let uidKey = kAudioAggregateDeviceUIDKey as CFString

// Enable drift compensation on both sub-devices (critical for Bluetooth/USB)
let driftOn = CFNumberCreate(kCFAllocatorDefault, .intType, [1])!
let subDeviceDicts: [[CFString: Any]] = [
    [subDeviceUIDKey: targetUID as CFString, subDeviceDriftKey: driftOn],
    [subDeviceUIDKey: blackholeUID as CFString, subDeviceDriftKey: driftOn]
]

let subDeviceArray = subDeviceDicts as CFArray

let desc: [CFString: Any] = [
    nameKey: deviceName,
    uidKey: deviceUID,
    stackedKey: kCFBooleanTrue as CFBoolean,
    subDeviceListKey: subDeviceArray
]

let cfDesc = desc as CFDictionary
var newDeviceID = AudioDeviceID()

let status = AudioHardwareCreateAggregateDevice(cfDesc, &newDeviceID)
if status != noErr {
    print("ERROR: Failed to create aggregate device. OSStatus: \(status)")
    exit(1)
}

// Set the master clock device (the physical output, not BlackHole)
var masterAddress = AudioObjectPropertyAddress(
    mSelector: kAudioAggregateDevicePropertyMainSubDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
var masterDevice = targetDevice
AudioObjectSetPropertyData(
    newDeviceID, &masterAddress, 0, nil,
    UInt32(MemoryLayout<AudioDeviceID>.size), &masterDevice
)

// Set sample rate to 48000 (common standard, avoids resync issues)
var sampleRate = Float64(48000.0)
var rateAddress = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyNominalSampleRate,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)
AudioObjectSetPropertyData(
    newDeviceID, &rateAddress, 0, nil,
    UInt32(MemoryLayout<Float64>.size), &sampleRate
)

print("OK:\(newDeviceID):created:\(deviceName as String)")
