using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Helmion.LocalService.Security;

internal static class CurrentUserDataProtection
{
    private const int CryptProtectUiForbidden = 0x1;

    public static byte[] Protect(
        ReadOnlySpan<byte> plaintext,
        ReadOnlySpan<byte> optionalEntropy)
    {
        return Transform(
            plaintext,
            optionalEntropy,
            protect: true);
    }

    public static byte[] Unprotect(
        ReadOnlySpan<byte> ciphertext,
        ReadOnlySpan<byte> optionalEntropy)
    {
        return Transform(
            ciphertext,
            optionalEntropy,
            protect: false);
    }

    private static byte[] Transform(
        ReadOnlySpan<byte> input,
        ReadOnlySpan<byte> optionalEntropy,
        bool protect)
    {
        var inputBlob = AllocateBlob(input);
        var entropyBlob = AllocateBlob(optionalEntropy);
        DataBlob outputBlob = default;
        IntPtr descriptionPointer = IntPtr.Zero;
        try
        {
            var succeeded = protect
                ? CryptProtectData(
                    ref inputBlob,
                    "Helmion protected provider profile",
                    ref entropyBlob,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    CryptProtectUiForbidden,
                    out outputBlob)
                : CryptUnprotectData(
                    ref inputBlob,
                    out descriptionPointer,
                    ref entropyBlob,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    CryptProtectUiForbidden,
                    out outputBlob);
            if (!succeeded)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    protect
                        ? "Windows could not protect the provider profile for the current user"
                        : "Windows could not unprotect the provider profile for the current user");
            }

            var output = new byte[outputBlob.Length];
            Marshal.Copy(outputBlob.Data, output, 0, outputBlob.Length);
            return output;
        }
        finally
        {
            FreeBlob(ref inputBlob, clear: true);
            FreeBlob(ref entropyBlob, clear: true);
            if (outputBlob.Data != IntPtr.Zero)
            {
                LocalFree(outputBlob.Data);
            }
            if (descriptionPointer != IntPtr.Zero)
            {
                LocalFree(descriptionPointer);
            }
        }
    }

    private static DataBlob AllocateBlob(ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty)
        {
            return default;
        }

        var data = Marshal.AllocHGlobal(bytes.Length);
        var copy = bytes.ToArray();
        try
        {
            Marshal.Copy(copy, 0, data, copy.Length);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(copy);
        }

        return new DataBlob
        {
            Length = bytes.Length,
            Data = data
        };
    }

    private static void FreeBlob(ref DataBlob blob, bool clear)
    {
        if (blob.Data == IntPtr.Zero)
        {
            return;
        }

        if (clear && blob.Length > 0)
        {
            var zeros = new byte[blob.Length];
            Marshal.Copy(zeros, 0, blob.Data, zeros.Length);
        }
        Marshal.FreeHGlobal(blob.Data);
        blob = default;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        public int Length;
        public IntPtr Data;
    }

    [DllImport(
        "crypt32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStructure,
        int flags,
        out DataBlob dataOut);

    [DllImport(
        "crypt32.dll",
        CharSet = CharSet.Unicode,
        SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        out IntPtr description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStructure,
        int flags,
        out DataBlob dataOut);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr memory);
}
