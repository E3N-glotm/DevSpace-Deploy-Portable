#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _SILENCE_EXPERIMENTAL_COROUTINE_DEPRECATION_WARNINGS
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "windowscodecs.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "windowsapp.lib")

using Microsoft::WRL::ComPtr;

namespace {

std::wstring HResultText(HRESULT value) {
    wchar_t* buffer = nullptr;
    const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
    const DWORD length = FormatMessageW(flags, nullptr, static_cast<DWORD>(value), 0,
        reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
    std::wostringstream stream;
    stream << L"0x" << std::hex << std::setw(8) << std::setfill(L'0') << static_cast<unsigned long>(value);
    if (length && buffer) {
        std::wstring message(buffer, length);
        while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) {
            message.pop_back();
        }
        stream << L" (" << message << L")";
    }
    if (buffer) {
        LocalFree(buffer);
    }
    return stream.str();
}

std::string Utf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }
    const int required = WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0) {
        return "Unable to encode Windows error text.";
    }
    std::string result(static_cast<std::size_t>(required), '\0');
    WideCharToMultiByte(
        CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), required, nullptr, nullptr);
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
    if (buffer) {
        LocalFree(buffer);
    }
    return Utf8(stream.str());
}

std::string JsonEscape(const std::string& value) {
    std::ostringstream stream;
    for (const unsigned char character : value) {
        switch (character) {
            case '\\': stream << "\\\\"; break;
            case '"': stream << "\\\""; break;
            case '\b': stream << "\\b"; break;
            case '\f': stream << "\\f"; break;
            case '\n': stream << "\\n"; break;
            case '\r': stream << "\\r"; break;
            case '\t': stream << "\\t"; break;
            default:
                if (character < 0x20) {
                    stream << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                        << static_cast<unsigned int>(character) << std::dec;
                } else {
                    stream << character;
                }
                break;
        }
    }
    return stream.str();
}

void Check(HRESULT value, const wchar_t* operation) {
    if (FAILED(value)) {
        std::wostringstream stream;
        stream << operation << L" failed: " << HResultText(value);
        const std::wstring detail = stream.str();
        throw std::runtime_error(Utf8(detail));
    }
}

void CheckWin32(BOOL value, const char* operation) {
    if (!value) {
        const DWORD error = GetLastError();
        throw std::runtime_error(std::string(operation) + " failed: " + Win32ErrorText(error));
    }
}

struct CoScope {
    HRESULT result{ E_FAIL };
    CoScope() : result(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {
        if (FAILED(result) && result != RPC_E_CHANGED_MODE) {
            Check(result, L"CoInitializeEx");
        }
    }
    ~CoScope() {
        if (SUCCEEDED(result)) {
            CoUninitialize();
        }
    }
};

struct DesktopBounds {
    LONG left{};
    LONG top{};
    UINT width{};
    UINT height{};
};

struct CaptureMetadata {
    DesktopBounds bounds{};
    UINT outputs{};
    std::string backend;
    std::string fallbackFrom;
    std::string fallbackError;
};

struct MonitorTarget {
    HMONITOR monitor{};
    RECT bounds{};
};

DesktopBounds GetDesktopBounds() {
    DesktopBounds bounds;
    bounds.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
    bounds.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
    bounds.width = static_cast<UINT>(GetSystemMetrics(SM_CXVIRTUALSCREEN));
    bounds.height = static_cast<UINT>(GetSystemMetrics(SM_CYVIRTUALSCREEN));
    if (bounds.width == 0 || bounds.height == 0) {
        throw std::runtime_error("Virtual desktop has zero width or height.");
    }
    return bounds;
}

BOOL CALLBACK CollectMonitor(HMONITOR monitor, HDC, LPRECT bounds, LPARAM context) {
    auto* monitors = reinterpret_cast<std::vector<MonitorTarget>*>(context);
    if (!monitors || !bounds) {
        return FALSE;
    }
    MONITORINFO information{};
    information.cbSize = sizeof(information);
    if (GetMonitorInfoW(monitor, &information)) {
        monitors->push_back(MonitorTarget{ monitor, information.rcMonitor });
    }
    return TRUE;
}

std::vector<MonitorTarget> GetMonitorTargets() {
    std::vector<MonitorTarget> monitors;
    CheckWin32(EnumDisplayMonitors(nullptr, nullptr, CollectMonitor,
        reinterpret_cast<LPARAM>(&monitors)), "EnumDisplayMonitors");
    if (monitors.empty()) {
        throw std::runtime_error("No attached desktop monitors were found.");
    }
    return monitors;
}

winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice CreateWinrtD3dDevice(
    ComPtr<ID3D11Device>& device,
    ComPtr<ID3D11DeviceContext>& context) {
    D3D_FEATURE_LEVEL requestedLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL selectedLevel{};
    HRESULT result = D3D11CreateDevice(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        requestedLevels,
        ARRAYSIZE(requestedLevels),
        D3D11_SDK_VERSION,
        &device,
        &selectedLevel,
        &context);
    if (result == E_INVALIDARG) {
        result = D3D11CreateDevice(
            nullptr,
            D3D_DRIVER_TYPE_HARDWARE,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            requestedLevels + 1,
            ARRAYSIZE(requestedLevels) - 1,
            D3D11_SDK_VERSION,
            &device,
            &selectedLevel,
            &context);
    }
    Check(result, L"D3D11CreateDevice(WGC)");
    ComPtr<IDXGIDevice> dxgiDevice;
    Check(device.As(&dxgiDevice), L"ID3D11Device::QueryInterface(IDXGIDevice)");
    winrt::com_ptr<IInspectable> inspectable;
    Check(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.Get(), inspectable.put()),
        L"CreateDirect3D11DeviceFromDXGIDevice");
    return inspectable.as<winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice>();
}

winrt::Windows::Graphics::Capture::GraphicsCaptureItem CreateCaptureItem(HMONITOR monitor) {
    using winrt::Windows::Graphics::Capture::GraphicsCaptureItem;
    auto interop = winrt::get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    GraphicsCaptureItem item{ nullptr };
    Check(interop->CreateForMonitor(
        monitor,
        winrt::guid_of<GraphicsCaptureItem>(),
        winrt::put_abi(item)), L"IGraphicsCaptureItemInterop::CreateForMonitor");
    return item;
}

void CopyWgcTexture(
    ID3D11Device* device,
    ID3D11DeviceContext* context,
    ID3D11Texture2D* texture,
    const RECT& monitorBounds,
    const DesktopBounds& desktopBounds,
    std::vector<std::uint8_t>& canvas) {
    D3D11_TEXTURE2D_DESC description{};
    texture->GetDesc(&description);
    if (description.Format != DXGI_FORMAT_B8G8R8A8_UNORM
        && description.Format != DXGI_FORMAT_B8G8R8A8_UNORM_SRGB) {
        throw std::runtime_error("Windows Graphics Capture returned an unsupported pixel format.");
    }
    D3D11_TEXTURE2D_DESC stagingDescription = description;
    stagingDescription.Usage = D3D11_USAGE_STAGING;
    stagingDescription.BindFlags = 0;
    stagingDescription.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    stagingDescription.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> stagingTexture;
    Check(device->CreateTexture2D(&stagingDescription, nullptr, &stagingTexture),
        L"ID3D11Device::CreateTexture2D(WGC staging)");
    context->CopyResource(stagingTexture.Get(), texture);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped),
        L"ID3D11DeviceContext::Map(WGC staging)");
    const UINT monitorWidth = static_cast<UINT>(monitorBounds.right - monitorBounds.left);
    const UINT monitorHeight = static_cast<UINT>(monitorBounds.bottom - monitorBounds.top);
    const UINT copyWidth = std::min(description.Width, monitorWidth);
    const UINT copyHeight = std::min(description.Height, monitorHeight);
    const LONG destinationX = monitorBounds.left - desktopBounds.left;
    const LONG destinationY = monitorBounds.top - desktopBounds.top;
    const std::size_t canvasStride = static_cast<std::size_t>(desktopBounds.width) * 4;
    for (UINT row = 0; row < copyHeight; ++row) {
        const auto* source = static_cast<const std::uint8_t*>(mapped.pData)
            + static_cast<std::size_t>(row) * mapped.RowPitch;
        auto* destination = canvas.data()
            + static_cast<std::size_t>(destinationY + static_cast<LONG>(row)) * canvasStride
            + static_cast<std::size_t>(destinationX) * 4;
        std::copy(source, source + static_cast<std::size_t>(copyWidth) * 4, destination);
    }
    context->Unmap(stagingTexture.Get(), 0);
}

void CaptureMonitorWgc(
    const MonitorTarget& target,
    const winrt::Windows::Graphics::DirectX::Direct3D11::IDirect3DDevice& winrtDevice,
    ID3D11Device* device,
    ID3D11DeviceContext* context,
    const DesktopBounds& desktopBounds,
    std::vector<std::uint8_t>& canvas) {
    using namespace winrt::Windows::Graphics::Capture;
    using winrt::Windows::Graphics::DirectX::DirectXPixelFormat;
    GraphicsCaptureItem item = CreateCaptureItem(target.monitor);
    const auto size = item.Size();
    Direct3D11CaptureFramePool framePool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        winrtDevice,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size);
    GraphicsCaptureSession session = framePool.CreateCaptureSession(item);
    std::mutex mutex;
    std::condition_variable condition;
    std::optional<Direct3D11CaptureFrame> capturedFrame;
    const auto token = framePool.FrameArrived([&](const Direct3D11CaptureFramePool& sender, const winrt::Windows::Foundation::IInspectable&) {
        try {
            auto frame = sender.TryGetNextFrame();
            std::lock_guard<std::mutex> lock(mutex);
            if (!capturedFrame.has_value()) {
                capturedFrame.emplace(std::move(frame));
                condition.notify_one();
            }
        }
        catch (...) {
            condition.notify_one();
        }
    });
    session.StartCapture();
    {
        std::unique_lock<std::mutex> lock(mutex);
        condition.wait_for(lock, std::chrono::seconds(4), [&] { return capturedFrame.has_value(); });
    }
    framePool.FrameArrived(token);
    if (!capturedFrame.has_value()) {
        session.Close();
        framePool.Close();
        throw std::runtime_error("Windows Graphics Capture timed out waiting for a desktop frame.");
    }
    auto surface = capturedFrame->Surface();
    using DxgiAccess = Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
    ComPtr<DxgiAccess> access;
    auto* inspectable = reinterpret_cast<IInspectable*>(winrt::get_abi(surface));
    Check(inspectable->QueryInterface(IID_PPV_ARGS(&access)),
        L"IDirect3DSurface::QueryInterface(IDirect3DDxgiInterfaceAccess)");
    ComPtr<ID3D11Texture2D> texture;
    Check(access->GetInterface(IID_PPV_ARGS(&texture)),
        L"IDirect3DDxgiInterfaceAccess::GetInterface(ID3D11Texture2D)");
    CopyWgcTexture(device, context, texture.Get(), target.bounds, desktopBounds, canvas);
    capturedFrame->Close();
    session.Close();
    framePool.Close();
}

void CopyRotatedPixels(
    const D3D11_MAPPED_SUBRESOURCE& mapped,
    UINT sourceWidth,
    UINT sourceHeight,
    DXGI_MODE_ROTATION rotation,
    const RECT& desktopRect,
    const DesktopBounds& bounds,
    std::vector<std::uint8_t>& canvas) {
    const LONG outputLeft = desktopRect.left - bounds.left;
    const LONG outputTop = desktopRect.top - bounds.top;
    const UINT desktopWidth = static_cast<UINT>(desktopRect.right - desktopRect.left);
    const UINT desktopHeight = static_cast<UINT>(desktopRect.bottom - desktopRect.top);
    const auto* source = static_cast<const std::uint8_t*>(mapped.pData);
    const std::size_t destinationStride = static_cast<std::size_t>(bounds.width) * 4;

    for (UINT sourceY = 0; sourceY < sourceHeight; ++sourceY) {
        const auto* sourceRow = source + static_cast<std::size_t>(sourceY) * mapped.RowPitch;
        for (UINT sourceX = 0; sourceX < sourceWidth; ++sourceX) {
            UINT localX = sourceX;
            UINT localY = sourceY;
            switch (rotation) {
                case DXGI_MODE_ROTATION_ROTATE90:
                    localX = sourceHeight - 1 - sourceY;
                    localY = sourceX;
                    break;
                case DXGI_MODE_ROTATION_ROTATE180:
                    localX = sourceWidth - 1 - sourceX;
                    localY = sourceHeight - 1 - sourceY;
                    break;
                case DXGI_MODE_ROTATION_ROTATE270:
                    localX = sourceY;
                    localY = sourceWidth - 1 - sourceX;
                    break;
                case DXGI_MODE_ROTATION_UNSPECIFIED:
                case DXGI_MODE_ROTATION_IDENTITY:
                default:
                    break;
            }
            if (localX >= desktopWidth || localY >= desktopHeight) {
                continue;
            }
            const LONG destinationX = outputLeft + static_cast<LONG>(localX);
            const LONG destinationY = outputTop + static_cast<LONG>(localY);
            if (destinationX < 0 || destinationY < 0
                || destinationX >= static_cast<LONG>(bounds.width)
                || destinationY >= static_cast<LONG>(bounds.height)) {
                continue;
            }
            const auto* pixel = sourceRow + static_cast<std::size_t>(sourceX) * 4;
            auto* destination = canvas.data()
                + static_cast<std::size_t>(destinationY) * destinationStride
                + static_cast<std::size_t>(destinationX) * 4;
            destination[0] = pixel[0];
            destination[1] = pixel[1];
            destination[2] = pixel[2];
            destination[3] = 0xFF;
        }
    }
}

void CaptureOutput(
    IDXGIAdapter1* adapter,
    IDXGIOutput* output,
    const DesktopBounds& bounds,
    std::vector<std::uint8_t>& canvas) {
    DXGI_OUTPUT_DESC outputDescription{};
    Check(output->GetDesc(&outputDescription), L"IDXGIOutput::GetDesc");
    if (!outputDescription.AttachedToDesktop) {
        return;
    }

    D3D_FEATURE_LEVEL requestedLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0,
    };
    D3D_FEATURE_LEVEL selectedLevel{};
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    HRESULT deviceResult = D3D11CreateDevice(
        adapter,
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        requestedLevels,
        ARRAYSIZE(requestedLevels),
        D3D11_SDK_VERSION,
        &device,
        &selectedLevel,
        &context);
    if (deviceResult == E_INVALIDARG) {
        deviceResult = D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            requestedLevels + 1,
            ARRAYSIZE(requestedLevels) - 1,
            D3D11_SDK_VERSION,
            &device,
            &selectedLevel,
            &context);
    }
    Check(deviceResult, L"D3D11CreateDevice");

    ComPtr<IDXGIOutput1> output1;
    Check(output->QueryInterface(IID_PPV_ARGS(&output1)), L"IDXGIOutput::QueryInterface(IDXGIOutput1)");
    ComPtr<IDXGIOutputDuplication> duplication;
    Check(output1->DuplicateOutput(device.Get(), &duplication), L"IDXGIOutput1::DuplicateOutput");

    DXGI_OUTDUPL_FRAME_INFO frameInformation{};
    ComPtr<IDXGIResource> desktopResource;
    HRESULT acquireResult = DXGI_ERROR_WAIT_TIMEOUT;
    for (int attempt = 0; attempt < 8 && acquireResult == DXGI_ERROR_WAIT_TIMEOUT; ++attempt) {
        acquireResult = duplication->AcquireNextFrame(500, &frameInformation, &desktopResource);
    }
    Check(acquireResult, L"IDXGIOutputDuplication::AcquireNextFrame");

    struct ReleaseFrameScope {
        IDXGIOutputDuplication* duplication{};
        ~ReleaseFrameScope() {
            if (duplication) {
                duplication->ReleaseFrame();
            }
        }
    } releaseFrame{ duplication.Get() };

    ComPtr<ID3D11Texture2D> desktopTexture;
    Check(desktopResource.As(&desktopTexture), L"IDXGIResource::As(ID3D11Texture2D)");
    D3D11_TEXTURE2D_DESC textureDescription{};
    desktopTexture->GetDesc(&textureDescription);
    if (textureDescription.Format != DXGI_FORMAT_B8G8R8A8_UNORM
        && textureDescription.Format != DXGI_FORMAT_B8G8R8A8_UNORM_SRGB) {
        throw std::runtime_error("Desktop duplication returned an unsupported pixel format.");
    }

    D3D11_TEXTURE2D_DESC stagingDescription = textureDescription;
    stagingDescription.Usage = D3D11_USAGE_STAGING;
    stagingDescription.BindFlags = 0;
    stagingDescription.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    stagingDescription.MiscFlags = 0;
    ComPtr<ID3D11Texture2D> stagingTexture;
    Check(device->CreateTexture2D(&stagingDescription, nullptr, &stagingTexture), L"ID3D11Device::CreateTexture2D");
    context->CopyResource(stagingTexture.Get(), desktopTexture.Get());

    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped), L"ID3D11DeviceContext::Map");
    CopyRotatedPixels(
        mapped,
        textureDescription.Width,
        textureDescription.Height,
        outputDescription.Rotation,
        outputDescription.DesktopCoordinates,
        bounds,
        canvas);
    context->Unmap(stagingTexture.Get(), 0);
}

void SavePngBgra32(
    const std::wstring& outputPath,
    const DesktopBounds& bounds,
    const std::vector<std::uint8_t>& pixels) {
    ComPtr<IWICImagingFactory> factory;
    Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)),
        L"CoCreateInstance(CLSID_WICImagingFactory)");
    ComPtr<IWICStream> stream;
    Check(factory->CreateStream(&stream), L"IWICImagingFactory::CreateStream");
    Check(stream->InitializeFromFilename(outputPath.c_str(), GENERIC_WRITE), L"IWICStream::InitializeFromFilename");
    ComPtr<IWICBitmapEncoder> encoder;
    Check(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder), L"IWICImagingFactory::CreateEncoder");
    Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), L"IWICBitmapEncoder::Initialize");
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> properties;
    Check(encoder->CreateNewFrame(&frame, &properties), L"IWICBitmapEncoder::CreateNewFrame");
    Check(frame->Initialize(properties.Get()), L"IWICBitmapFrameEncode::Initialize");
    Check(frame->SetSize(bounds.width, bounds.height), L"IWICBitmapFrameEncode::SetSize");
    WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
    Check(frame->SetPixelFormat(&format), L"IWICBitmapFrameEncode::SetPixelFormat");
    if (!IsEqualGUID(format, GUID_WICPixelFormat32bppBGRA)) {
        throw std::runtime_error("PNG encoder rejected 32bpp BGRA pixels.");
    }
    const UINT stride = bounds.width * 4;
    const std::size_t totalBytes = static_cast<std::size_t>(stride) * bounds.height;
    if (totalBytes > static_cast<std::size_t>(UINT_MAX)) {
        throw std::runtime_error("Virtual desktop is too large for WIC WritePixels.");
    }
    Check(frame->WritePixels(bounds.height, stride, static_cast<UINT>(totalBytes),
        const_cast<BYTE*>(pixels.data())), L"IWICBitmapFrameEncode::WritePixels");
    Check(frame->Commit(), L"IWICBitmapFrameEncode::Commit");
    Check(encoder->Commit(), L"IWICBitmapEncoder::Commit");
}

void ValidateVisibleBgraFrame(
    const std::vector<std::uint8_t>& pixels,
    const std::string& backend) {
    if (pixels.empty() || pixels.size() % 4 != 0) {
        throw std::runtime_error(backend + " returned an invalid desktop frame buffer.");
    }
    const std::size_t pixelCount = pixels.size() / 4;
    const std::size_t requiredVisiblePixels = std::max<std::size_t>(1024, pixelCount / 1000);
    std::size_t visiblePixels = 0;
    for (std::size_t offset = 0; offset < pixels.size(); offset += 4) {
        if (pixels[offset] != 0 || pixels[offset + 1] != 0 || pixels[offset + 2] != 0) {
            if (++visiblePixels >= requiredVisiblePixels) return;
        }
    }
    throw std::runtime_error(
        backend + " returned an empty desktop frame. The display may be locked, asleep, protected, or attached to a non-interactive desktop.");
}

void ValidateVisibleBgr24Frame(
    const std::vector<std::uint8_t>& pixels,
    UINT width,
    UINT height,
    UINT stride,
    const std::string& backend) {
    if (pixels.empty() || width == 0 || height == 0
        || stride < width * 3U
        || pixels.size() < static_cast<std::size_t>(stride) * height) {
        throw std::runtime_error(backend + " returned an invalid desktop frame buffer.");
    }
    const std::size_t pixelCount = static_cast<std::size_t>(width) * height;
    const std::size_t requiredVisiblePixels = std::max<std::size_t>(1024, pixelCount / 1000);
    std::size_t visiblePixels = 0;
    for (UINT row = 0; row < height; ++row) {
        const auto* source = pixels.data() + static_cast<std::size_t>(row) * stride;
        for (UINT column = 0; column < width; ++column) {
            const auto* pixel = source + static_cast<std::size_t>(column) * 3;
            if (pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0) {
                if (++visiblePixels >= requiredVisiblePixels) return;
            }
        }
    }
    throw std::runtime_error(
        backend + " returned an empty desktop frame. The display may be locked, asleep, protected, or attached to a non-interactive desktop.");
}

void SavePngBgr24(
    const std::wstring& outputPath,
    const DesktopBounds& bounds,
    const std::vector<std::uint8_t>& pixels,
    UINT stride) {
    ComPtr<IWICImagingFactory> factory;
    Check(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)),
        L"CoCreateInstance(CLSID_WICImagingFactory)");
    ComPtr<IWICStream> stream;
    Check(factory->CreateStream(&stream), L"IWICImagingFactory::CreateStream");
    Check(stream->InitializeFromFilename(outputPath.c_str(), GENERIC_WRITE), L"IWICStream::InitializeFromFilename");
    ComPtr<IWICBitmapEncoder> encoder;
    Check(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder), L"IWICImagingFactory::CreateEncoder");
    Check(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache), L"IWICBitmapEncoder::Initialize");
    ComPtr<IWICBitmapFrameEncode> frame;
    ComPtr<IPropertyBag2> properties;
    Check(encoder->CreateNewFrame(&frame, &properties), L"IWICBitmapEncoder::CreateNewFrame");
    Check(frame->Initialize(properties.Get()), L"IWICBitmapFrameEncode::Initialize");
    Check(frame->SetSize(bounds.width, bounds.height), L"IWICBitmapFrameEncode::SetSize");
    WICPixelFormatGUID format = GUID_WICPixelFormat24bppBGR;
    Check(frame->SetPixelFormat(&format), L"IWICBitmapFrameEncode::SetPixelFormat");
    if (!IsEqualGUID(format, GUID_WICPixelFormat24bppBGR)) {
        throw std::runtime_error("PNG encoder rejected 24bpp BGR pixels.");
    }
    const std::size_t totalBytes = static_cast<std::size_t>(stride) * bounds.height;
    if (totalBytes > static_cast<std::size_t>(UINT_MAX)) {
        throw std::runtime_error("Virtual desktop is too large for WIC WritePixels.");
    }
    Check(frame->WritePixels(bounds.height, stride, static_cast<UINT>(totalBytes),
        const_cast<BYTE*>(pixels.data())), L"IWICBitmapFrameEncode::WritePixels");
    Check(frame->Commit(), L"IWICBitmapFrameEncode::Commit");
    Check(encoder->Commit(), L"IWICBitmapEncoder::Commit");
}

CaptureMetadata CaptureDesktopWgc(const std::wstring& outputPath) {
    using winrt::Windows::Graphics::Capture::GraphicsCaptureSession;
    if (!GraphicsCaptureSession::IsSupported()) {
        throw std::runtime_error("Windows Graphics Capture is not supported in this Windows session.");
    }
    const DesktopBounds bounds = GetDesktopBounds();
    std::vector<std::uint8_t> canvas(static_cast<std::size_t>(bounds.width) * bounds.height * 4, 0);
    for (std::size_t offset = 3; offset < canvas.size(); offset += 4) {
        canvas[offset] = 0xFF;
    }
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    const auto winrtDevice = CreateWinrtD3dDevice(device, context);
    const auto monitors = GetMonitorTargets();
    for (const auto& monitor : monitors) {
        CaptureMonitorWgc(monitor, winrtDevice, device.Get(), context.Get(), bounds, canvas);
    }
    ValidateVisibleBgraFrame(canvas, "Windows Graphics Capture");
    SavePngBgra32(outputPath, bounds, canvas);
    return CaptureMetadata{ bounds, static_cast<UINT>(monitors.size()), "wgc", {}, {} };
}

CaptureMetadata CaptureDesktopDxgi(const std::wstring& outputPath) {
    const DesktopBounds bounds = GetDesktopBounds();
    std::vector<std::uint8_t> canvas(static_cast<std::size_t>(bounds.width) * bounds.height * 4, 0);
    for (std::size_t offset = 3; offset < canvas.size(); offset += 4) {
        canvas[offset] = 0xFF;
    }

    ComPtr<IDXGIFactory1> factory;
    Check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)), L"CreateDXGIFactory1");
    UINT attachedOutputs = 0;
    for (UINT adapterIndex = 0;; ++adapterIndex) {
        ComPtr<IDXGIAdapter1> adapter;
        const HRESULT adapterResult = factory->EnumAdapters1(adapterIndex, &adapter);
        if (adapterResult == DXGI_ERROR_NOT_FOUND) {
            break;
        }
        Check(adapterResult, L"IDXGIFactory1::EnumAdapters1");
        for (UINT outputIndex = 0;; ++outputIndex) {
            ComPtr<IDXGIOutput> output;
            const HRESULT outputResult = adapter->EnumOutputs(outputIndex, &output);
            if (outputResult == DXGI_ERROR_NOT_FOUND) {
                break;
            }
            Check(outputResult, L"IDXGIAdapter1::EnumOutputs");
            DXGI_OUTPUT_DESC description{};
            Check(output->GetDesc(&description), L"IDXGIOutput::GetDesc");
            if (!description.AttachedToDesktop) {
                continue;
            }
            CaptureOutput(adapter.Get(), output.Get(), bounds, canvas);
            ++attachedOutputs;
        }
    }
    if (attachedOutputs == 0) {
        throw std::runtime_error("No attached desktop outputs were found.");
    }
    ValidateVisibleBgraFrame(canvas, "Desktop Duplication");
    SavePngBgra32(outputPath, bounds, canvas);
    return CaptureMetadata{ bounds, attachedOutputs, "dxgi", {}, {} };
}

CaptureMetadata CaptureDesktopGdi(const std::wstring& outputPath) {
    const DesktopBounds bounds = GetDesktopBounds();

    using SetThreadDpiAwarenessContextFunction = HANDLE(WINAPI*)(HANDLE);
    HMODULE user32 = LoadLibraryW(L"User32.dll");
    SetThreadDpiAwarenessContextFunction setDpiAwareness = user32
        ? reinterpret_cast<SetThreadDpiAwarenessContextFunction>(
            GetProcAddress(user32, "SetThreadDpiAwarenessContext"))
        : nullptr;
    HANDLE previousDpiAwareness = nullptr;
    if (setDpiAwareness) {
        previousDpiAwareness = setDpiAwareness(reinterpret_cast<HANDLE>(-3));
    }

    HDC screen = GetDC(nullptr);
    if (!screen) {
        if (setDpiAwareness && previousDpiAwareness) setDpiAwareness(previousDpiAwareness);
        if (user32) FreeLibrary(user32);
        throw std::runtime_error("GetDC(desktop) failed: " + Win32ErrorText(GetLastError()));
    }
    HDC screenCopy = CreateCompatibleDC(screen);
    if (!screenCopy) {
        ReleaseDC(nullptr, screen);
        if (setDpiAwareness && previousDpiAwareness) setDpiAwareness(previousDpiAwareness);
        if (user32) FreeLibrary(user32);
        throw std::runtime_error("CreateCompatibleDC failed: " + Win32ErrorText(GetLastError()));
    }
    HBITMAP bitmap = CreateCompatibleBitmap(screen, static_cast<int>(bounds.width), static_cast<int>(bounds.height));
    if (!bitmap) {
        DeleteDC(screenCopy);
        ReleaseDC(nullptr, screen);
        if (setDpiAwareness && previousDpiAwareness) setDpiAwareness(previousDpiAwareness);
        if (user32) FreeLibrary(user32);
        throw std::runtime_error("CreateCompatibleBitmap failed: " + Win32ErrorText(GetLastError()));
    }
    HGDIOBJ previousBitmap = SelectObject(screenCopy, bitmap);
    if (!previousBitmap || previousBitmap == HGDI_ERROR) {
        DeleteObject(bitmap);
        DeleteDC(screenCopy);
        ReleaseDC(nullptr, screen);
        if (setDpiAwareness && previousDpiAwareness) setDpiAwareness(previousDpiAwareness);
        if (user32) FreeLibrary(user32);
        throw std::runtime_error("SelectObject failed: " + Win32ErrorText(GetLastError()));
    }

    bool bitmapSelected = true;
    try {
        CheckWin32(BitBlt(
            screenCopy,
            0,
            0,
            static_cast<int>(bounds.width),
            static_cast<int>(bounds.height),
            screen,
            bounds.left,
            bounds.top,
            SRCCOPY | CAPTUREBLT), "BitBlt");

        HGDIOBJ restoredSelection = SelectObject(screenCopy, previousBitmap);
        if (!restoredSelection || restoredSelection == HGDI_ERROR) {
            throw std::runtime_error("SelectObject(restore before GetDIBits) failed: " + Win32ErrorText(GetLastError()));
        }
        bitmapSelected = false;

        const UINT stride = (bounds.width * 3U + 3U) & ~3U;
        const std::size_t totalBytes = static_cast<std::size_t>(stride) * bounds.height;
        std::vector<std::uint8_t> bottomUp(totalBytes);
        BITMAPINFO bitmapInformation{};
        bitmapInformation.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        bitmapInformation.bmiHeader.biWidth = static_cast<LONG>(bounds.width);
        bitmapInformation.bmiHeader.biHeight = static_cast<LONG>(bounds.height);
        bitmapInformation.bmiHeader.biPlanes = 1;
        bitmapInformation.bmiHeader.biBitCount = 24;
        bitmapInformation.bmiHeader.biCompression = BI_RGB;
        const int rows = GetDIBits(
            screenCopy,
            bitmap,
            0,
            bounds.height,
            bottomUp.data(),
            &bitmapInformation,
            DIB_RGB_COLORS);
        if (rows != static_cast<int>(bounds.height)) {
            throw std::runtime_error("GetDIBits failed: " + Win32ErrorText(GetLastError()));
        }
        std::vector<std::uint8_t> topDown(totalBytes);
        for (UINT row = 0; row < bounds.height; ++row) {
            const auto* source = bottomUp.data()
                + static_cast<std::size_t>(bounds.height - 1U - row) * stride;
            auto* destination = topDown.data() + static_cast<std::size_t>(row) * stride;
            std::copy(source, source + stride, destination);
        }
        ValidateVisibleBgr24Frame(topDown, bounds.width, bounds.height, stride, "GDI BitBlt");
        SavePngBgr24(outputPath, bounds, topDown, stride);
    }
    catch (...) {
        if (bitmapSelected) SelectObject(screenCopy, previousBitmap);
        DeleteObject(bitmap);
        DeleteDC(screenCopy);
        ReleaseDC(nullptr, screen);
        if (setDpiAwareness && previousDpiAwareness) setDpiAwareness(previousDpiAwareness);
        if (user32) FreeLibrary(user32);
        throw;
    }

    if (bitmapSelected) SelectObject(screenCopy, previousBitmap);
    DeleteObject(bitmap);
    DeleteDC(screenCopy);
    ReleaseDC(nullptr, screen);
    if (setDpiAwareness && previousDpiAwareness) setDpiAwareness(previousDpiAwareness);
    if (user32) FreeLibrary(user32);
    return CaptureMetadata{ bounds, 1, "gdi", {}, {} };
}

CaptureMetadata CaptureDesktop(const std::wstring& outputPath, const std::string& requestedBackend) {
    if (requestedBackend == "wgc") {
        return CaptureDesktopWgc(outputPath);
    }
    if (requestedBackend == "dxgi") {
        return CaptureDesktopDxgi(outputPath);
    }
    if (requestedBackend == "gdi") {
        return CaptureDesktopGdi(outputPath);
    }
    std::vector<std::pair<std::string, std::string>> errors;
    try {
        return CaptureDesktopWgc(outputPath);
    } catch (const std::exception& error) {
        errors.emplace_back("wgc", error.what());
        DeleteFileW(outputPath.c_str());
    }
    try {
        CaptureMetadata metadata = CaptureDesktopDxgi(outputPath);
        metadata.fallbackFrom = "wgc";
        metadata.fallbackError = errors.front().second;
        return metadata;
    } catch (const std::exception& error) {
        errors.emplace_back("dxgi", error.what());
        DeleteFileW(outputPath.c_str());
    }
    try {
        CaptureMetadata metadata = CaptureDesktopGdi(outputPath);
        metadata.fallbackFrom = "wgc,dxgi";
        metadata.fallbackError = "wgc: " + errors[0].second + " | dxgi: " + errors[1].second;
        return metadata;
    } catch (const std::exception& error) {
        errors.emplace_back("gdi", error.what());
    }
    throw std::runtime_error(
        "All desktop capture backends failed. wgc: " + errors[0].second
        + " | dxgi: " + errors[1].second
        + " | gdi: " + errors[2].second);
}

void PrintMetadata(const CaptureMetadata& metadata) {
    std::cout << "{\"width\":" << metadata.bounds.width
        << ",\"height\":" << metadata.bounds.height
        << ",\"left\":" << metadata.bounds.left
        << ",\"top\":" << metadata.bounds.top
        << ",\"outputs\":" << metadata.outputs
        << ",\"backend\":\"" << JsonEscape(metadata.backend) << "\"";
    if (!metadata.fallbackError.empty()) {
        std::cout << ",\"fallbackFrom\":\"" << JsonEscape(metadata.fallbackFrom) << "\""
            << ",\"fallbackError\":\"" << JsonEscape(metadata.fallbackError) << "\"";
    }
    std::cout << "}" << std::endl;
}

} // namespace

int wmain(int argc, wchar_t** argv) {
    if ((argc != 2 && argc != 3) || !argv[1] || !*argv[1]) {
        std::wcerr << L"Usage: computer-use-capture.exe <output.png> [auto|wgc|dxgi|gdi]" << std::endl;
        return 2;
    }
    try {
        CoScope com;
        std::string backend = "auto";
        if (argc == 3 && argv[2]) {
            backend = Utf8(argv[2]);
            std::transform(backend.begin(), backend.end(), backend.begin(),
                [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
        }
        if (backend != "auto" && backend != "wgc" && backend != "dxgi" && backend != "gdi") {
            throw std::runtime_error("Unsupported capture backend: " + backend);
        }
        PrintMetadata(CaptureDesktop(argv[1], backend));
        return 0;
    }
    catch (const std::exception& error) {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}

