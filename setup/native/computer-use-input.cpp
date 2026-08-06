#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#pragma comment(lib, "user32.lib")

namespace {

struct Options {
    std::string action;
    bool hasX{ false };
    bool hasY{ false };
    int x{};
    int y{};
    int delta{};
    int delayMs{};
    std::vector<std::string> keys;
    std::wstring textFile;
};

std::wstring Utf8ToWide(const std::string& value) {
    if (value.empty()) return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0) throw std::runtime_error("Invalid UTF-8 text.");
    std::wstring result(static_cast<std::size_t>(required), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
        value.data(), static_cast<int>(value.size()), result.data(), required);
    return result;
}

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) return {};
    const int required = WideCharToMultiByte(CP_UTF8, 0,
        value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0) return "Unable to encode Windows error text.";
    std::string result(static_cast<std::size_t>(required), '\0');
    WideCharToMultiByte(CP_UTF8, 0,
        value.data(), static_cast<int>(value.size()), result.data(), required, nullptr, nullptr);
    return result;
}

std::string Win32ErrorText(DWORD value) {
    wchar_t* buffer = nullptr;
    const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
    const DWORD length = FormatMessageW(flags, nullptr, value, 0,
        reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
    std::wostringstream stream;
    stream << L"Win32 error " << value;
    if (length && buffer) {
        std::wstring message(buffer, length);
        while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) {
            message.pop_back();
        }
        stream << L" (" << message << L")";
    }
    if (buffer) LocalFree(buffer);
    return WideToUtf8(stream.str());
}

int ParseInteger(const wchar_t* value, const char* name) {
    if (!value || !*value) throw std::runtime_error(std::string(name) + " requires an integer.");
    wchar_t* end = nullptr;
    const long parsed = wcstol(value, &end, 10);
    if (!end || *end != L'\0' || parsed < INT_MIN || parsed > INT_MAX) {
        throw std::runtime_error(std::string(name) + " is not a valid integer.");
    }
    return static_cast<int>(parsed);
}

Options ParseOptions(int argc, wchar_t** argv) {
    Options options;
    for (int index = 1; index < argc; ++index) {
        const std::wstring argument = argv[index] ? argv[index] : L"";
        auto next = [&]() -> const wchar_t* {
            if (index + 1 >= argc) throw std::runtime_error("Missing value for command-line argument.");
            return argv[++index];
        };
        if (argument == L"--action") {
            options.action = WideToUtf8(next());
        } else if (argument == L"--x") {
            options.x = ParseInteger(next(), "x");
            options.hasX = true;
        } else if (argument == L"--y") {
            options.y = ParseInteger(next(), "y");
            options.hasY = true;
        } else if (argument == L"--delta") {
            options.delta = ParseInteger(next(), "delta");
        } else if (argument == L"--delay") {
            options.delayMs = ParseInteger(next(), "delay");
        } else if (argument == L"--key") {
            options.keys.push_back(WideToUtf8(next()));
        } else if (argument == L"--text-file") {
            options.textFile = next();
        } else {
            throw std::runtime_error("Unsupported command-line argument: " + WideToUtf8(argument));
        }
    }
    std::transform(options.action.begin(), options.action.end(), options.action.begin(),
        [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if (options.action.empty()) throw std::runtime_error("--action is required.");
    options.delayMs = std::clamp(options.delayMs, 0, 3000);
    return options;
}

void AssertInteractiveDesktop() {
    constexpr DWORD access = DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS | DESKTOP_SWITCHDESKTOP;
    HDESK desktop = OpenInputDesktop(0, FALSE, access);
    if (!desktop) {
        throw std::runtime_error(
            "The interactive input desktop is unavailable. Keep the local DevSpace Portable UI open and the Windows session unlocked: "
            + Win32ErrorText(GetLastError()));
    }
    CloseDesktop(desktop);
}

RECT VirtualDesktop() {
    RECT bounds{};
    bounds.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    bounds.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    bounds.right = bounds.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
    bounds.bottom = bounds.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
        throw std::runtime_error("Virtual desktop dimensions are invalid.");
    }
    return bounds;
}

void SetPoint(const Options& options, const RECT& bounds) {
    if (!options.hasX || !options.hasY) throw std::runtime_error("x and y are required for this action.");
    if (options.x < bounds.left || options.x >= bounds.right
        || options.y < bounds.top || options.y >= bounds.bottom) {
        throw std::runtime_error("Mouse coordinates are outside the virtual desktop.");
    }
    if (!SetCursorPos(options.x, options.y)) {
        throw std::runtime_error("SetCursorPos failed: " + Win32ErrorText(GetLastError()));
    }
}

void SendMouse(DWORD flags, DWORD data = 0) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = flags;
    input.mi.mouseData = data;
    if (SendInput(1, &input, sizeof(INPUT)) != 1) {
        throw std::runtime_error("SendInput(mouse) failed: " + Win32ErrorText(GetLastError()));
    }
}

void Click(DWORD down, DWORD up) {
    SendMouse(down);
    SendMouse(up);
}

struct KeySequence {
    std::vector<WORD> modifiers;
    WORD key{};
};

KeySequence ParseKey(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(),
        [](unsigned char character) { return static_cast<char>(std::toupper(character)); });
    static const std::map<std::string, WORD> simple = {
        { "ENTER", VK_RETURN }, { "TAB", VK_TAB }, { "ESCAPE", VK_ESCAPE },
        { "BACKSPACE", VK_BACK }, { "DELETE", VK_DELETE }, { "UP", VK_UP },
        { "DOWN", VK_DOWN }, { "LEFT", VK_LEFT }, { "RIGHT", VK_RIGHT },
        { "HOME", VK_HOME }, { "END", VK_END }, { "PAGEUP", VK_PRIOR },
        { "PAGEDOWN", VK_NEXT }, { "F1", VK_F1 }, { "F2", VK_F2 },
        { "F3", VK_F3 }, { "F4", VK_F4 }, { "F5", VK_F5 },
        { "F6", VK_F6 }, { "F7", VK_F7 }, { "F8", VK_F8 },
        { "F9", VK_F9 }, { "F10", VK_F10 }, { "F11", VK_F11 }, { "F12", VK_F12 },
    };
    const auto simpleMatch = simple.find(value);
    if (simpleMatch != simple.end()) return KeySequence{ {}, simpleMatch->second };
    if (value == "ALT+F4") return KeySequence{ { VK_MENU }, VK_F4 };
    if (value.rfind("CTRL+", 0) == 0 && value.size() == 6) {
        const char letter = value[5];
        if (letter >= 'A' && letter <= 'Z'
            && std::string("ACVXZYSFL").find(letter) != std::string::npos) {
            return KeySequence{ { VK_CONTROL }, static_cast<WORD>(letter) };
        }
    }
    throw std::runtime_error("Unsupported key: " + value);
}

void SendVirtualKey(WORD key, bool keyUp) {
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    input.ki.wVk = key;
    input.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
    if (SendInput(1, &input, sizeof(INPUT)) != 1) {
        throw std::runtime_error("SendInput(keyboard) failed: " + Win32ErrorText(GetLastError()));
    }
}

void SendKeySequence(const KeySequence& sequence) {
    for (const WORD modifier : sequence.modifiers) SendVirtualKey(modifier, false);
    SendVirtualKey(sequence.key, false);
    SendVirtualKey(sequence.key, true);
    for (auto iterator = sequence.modifiers.rbegin(); iterator != sequence.modifiers.rend(); ++iterator) {
        SendVirtualKey(*iterator, true);
    }
}

std::wstring ReadUtf8Text(const std::wstring& file) {
    if (file.empty()) throw std::runtime_error("type_text requires --text-file.");
    std::ifstream stream(file, std::ios::binary);
    if (!stream) throw std::runtime_error("Unable to open the text input file.");
    std::string bytes((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    if (bytes.size() > 80'000) throw std::runtime_error("Text input file is too large.");
    return Utf8ToWide(bytes);
}

void SendUnicodeText(const std::wstring& text) {
    for (const wchar_t character : text) {
        if (character == L'\r') continue;
        if (character == L'\n') {
            SendKeySequence(KeySequence{ {}, VK_RETURN });
            continue;
        }
        if (character == L'\t') {
            SendKeySequence(KeySequence{ {}, VK_TAB });
            continue;
        }
        INPUT inputs[2]{};
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].ki.wScan = static_cast<WORD>(character);
        inputs[0].ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1] = inputs[0];
        inputs[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        if (SendInput(2, inputs, sizeof(INPUT)) != 2) {
            throw std::runtime_error("SendInput(unicode) failed: " + Win32ErrorText(GetLastError()));
        }
    }
}

void Execute(const Options& options, const RECT& bounds) {
    if (options.action == "broker_probe") return;
    AssertInteractiveDesktop();
    if (options.action == "move") {
        SetPoint(options, bounds);
    } else if (options.action == "click") {
        SetPoint(options, bounds);
        Click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
    } else if (options.action == "double_click") {
        SetPoint(options, bounds);
        Click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
        Sleep(std::min<DWORD>(75, GetDoubleClickTime() / 2));
        Click(MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP);
    } else if (options.action == "right_click") {
        SetPoint(options, bounds);
        Click(MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP);
    } else if (options.action == "scroll") {
        if (options.hasX || options.hasY) SetPoint(options, bounds);
        SendMouse(MOUSEEVENTF_WHEEL, static_cast<DWORD>(options.delta));
    } else if (options.action == "keypress") {
        if (options.keys.empty()) throw std::runtime_error("keypress requires at least one key.");
        for (const auto& key : options.keys) SendKeySequence(ParseKey(key));
    } else if (options.action == "type_text") {
        SendUnicodeText(ReadUtf8Text(options.textFile));
    } else {
        throw std::runtime_error("Unsupported action: " + options.action);
    }
    if (options.delayMs > 0) Sleep(static_cast<DWORD>(options.delayMs));
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        const Options options = ParseOptions(argc, argv);
        const RECT bounds = VirtualDesktop();
        Execute(options, bounds);
        std::cout << "{\"action\":\"" << options.action
            << "\",\"left\":" << bounds.left
            << ",\"top\":" << bounds.top
            << ",\"width\":" << (bounds.right - bounds.left)
            << ",\"height\":" << (bounds.bottom - bounds.top)
            << ",\"screenshot\":false}"
            << std::endl;
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
