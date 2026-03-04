/**
 * Unit Tests for Windows Path Auto-Translation in sanitizePath()
 *
 * Tests the auto-translation feature added to sanitizePath() in
 * src/utils/validation.ts that converts Windows-style paths (e.g.,
 * C:\Users\hotra\Documents\file.pdf) to Linux /host mount paths
 * (e.g., /host/Users/hotra/Documents/file.pdf) when running on Linux.
 *
 * This is critical for Docker environments where the MCP client runs
 * on Windows but the server runs on Linux with /host volume mounts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizePath, ValidationError } from '../../../src/utils/validation.js';

describe('sanitizePath - Windows path auto-translation', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 1: Auto-translation (happy path)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 1: Auto-translation happy path', () => {
    it('should translate C:\\Users\\hotra\\Documents\\file.pdf to /host/Users/hotra/Documents/file.pdf', () => {
      const result = sanitizePath('C:\\Users\\hotra\\Documents\\file.pdf', ['/host']);
      expect(result).toBe('/host/Users/hotra/Documents/file.pdf');
    });

    it('should translate C:/Users/hotra/Documents/file.pdf (forward slashes) to /host/Users/hotra/Documents/file.pdf', () => {
      const result = sanitizePath('C:/Users/hotra/Documents/file.pdf', ['/host']);
      expect(result).toBe('/host/Users/hotra/Documents/file.pdf');
    });

    it('should translate D:\\data\\file.pdf (different drive letter) to /host/data/file.pdf', () => {
      const result = sanitizePath('D:\\data\\file.pdf', ['/host']);
      expect(result).toBe('/host/data/file.pdf');
    });

    it('should translate c:\\lowercase.txt (lowercase drive) to /host/lowercase.txt', () => {
      const result = sanitizePath('c:\\lowercase.txt', ['/host']);
      expect(result).toBe('/host/lowercase.txt');
    });

    it('should translate C:\\Users/hotra\\Documents/mixed.pdf (mixed slashes) to /host/Users/hotra/Documents/mixed.pdf', () => {
      const result = sanitizePath('C:\\Users/hotra\\Documents/mixed.pdf', ['/host']);
      expect(result).toBe('/host/Users/hotra/Documents/mixed.pdf');
    });

    it('should translate Z:\\deep\\nested\\path\\to\\file.txt (unusual drive letter) to /host/deep/nested/path/to/file.txt', () => {
      const result = sanitizePath('Z:\\deep\\nested\\path\\to\\file.txt', ['/host']);
      expect(result).toBe('/host/deep/nested/path/to/file.txt');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 2: Validation after translation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 2: Validation after translation', () => {
    it('should reject auto-translated path when /host is NOT in allowedBaseDirs', () => {
      expect(() => {
        sanitizePath('C:\\Users\\hotra\\Documents\\file.pdf', ['/tmp']);
      }).toThrow(ValidationError);

      expect(() => {
        sanitizePath('C:\\Users\\hotra\\Documents\\file.pdf', ['/tmp']);
      }).toThrow('outside allowed directories');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 3: Non-Windows paths unchanged
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 3: Non-Windows paths unchanged', () => {
    it('should pass /home/user/file.pdf through unchanged', () => {
      const result = sanitizePath('/home/user/file.pdf', ['/home']);
      expect(result).toBe('/home/user/file.pdf');
    });

    it('should pass /tmp/test.txt through unchanged', () => {
      const result = sanitizePath('/tmp/test.txt', ['/tmp']);
      expect(result).toBe('/tmp/test.txt');
    });

    it('should resolve relative path ./file.txt normally against cwd', () => {
      const cwd = process.cwd();
      const result = sanitizePath('./file.txt', [cwd]);
      expect(result).toBe(`${cwd}/file.txt`);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 4: Edge cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 4: Edge cases', () => {
    it('should reject null bytes before auto-translation', () => {
      expect(() => {
        sanitizePath('C:\\Users\\hotra\0\\file.pdf', ['/host']);
      }).toThrow(ValidationError);

      expect(() => {
        sanitizePath('C:\\Users\\hotra\0\\file.pdf', ['/host']);
      }).toThrow('Path contains null bytes');
    });

    it('should NOT trigger auto-translation for C:file.txt (no separator after colon)', () => {
      // C:file.txt does NOT match the regex /^[a-zA-Z]:[/\\]/ because
      // the character after the colon is 'f', not '/' or '\'.
      // This should be treated as a relative path, not a Windows absolute path.
      // It will resolve relative to cwd, so we allow cwd as the base dir.
      const cwd = process.cwd();
      const result = sanitizePath('C:file.txt', [cwd]);
      // Should resolve relative to cwd, not translate to /host
      expect(result).toBe(`${cwd}/C:file.txt`);
      // And console.error should NOT have been called with the translation message
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[path-sanitize] Auto-translated')
      );
    });

    it('should NOT trigger auto-translation for UNC paths (\\\\server\\share\\file.txt)', () => {
      // UNC paths start with \\, not a drive letter, so they don't match
      // the regex /^[a-zA-Z]:[/\\]/
      // On Linux, path.resolve will resolve \\server\share\file.txt relative to cwd.
      const cwd = process.cwd();
      const result = sanitizePath('\\\\server\\share\\file.txt', [cwd]);
      // Should NOT have triggered auto-translation logging
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('[path-sanitize] Auto-translated')
      );
      // The path should be resolved relative to cwd (since it's not a Windows path on Linux)
      expect(result).toContain(cwd);
    });

    it('should translate bare drive root C:\\ to /host/', () => {
      const result = sanitizePath('C:\\', ['/host']);
      // C:\ -> slice(2) = '\' -> replace backslash = '/' -> '/host' + '/' = '/host/'
      // path.resolve('/host/') = '/host'
      expect(result).toBe('/host');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUP 5: stderr logging
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 5: stderr logging', () => {
    it('should call console.error with translation message when auto-translation happens', () => {
      sanitizePath('C:\\Users\\hotra\\Documents\\file.pdf', ['/host']);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[path-sanitize] Auto-translated')
      );
    });

    it('should include both original and translated path in console.error message', () => {
      sanitizePath('C:\\Users\\hotra\\Documents\\file.pdf', ['/host']);

      const loggedMessage = consoleErrorSpy.mock.calls[0][0] as string;
      // Original Windows path must be present
      expect(loggedMessage).toContain('C:\\Users\\hotra\\Documents\\file.pdf');
      // Translated Linux path must be present
      expect(loggedMessage).toContain('/host/Users/hotra/Documents/file.pdf');
    });

    it('should NOT call console.error for non-Windows paths', () => {
      sanitizePath('/tmp/test.txt', ['/tmp']);
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional robustness tests
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Additional robustness', () => {
    it('should handle deeply nested Windows paths', () => {
      const deepPath = 'C:\\a\\b\\c\\d\\e\\f\\g\\h\\i\\j\\file.txt';
      const result = sanitizePath(deepPath, ['/host']);
      expect(result).toBe('/host/a/b/c/d/e/f/g/h/i/j/file.txt');
    });

    it('should handle Windows paths with spaces in directory names', () => {
      const result = sanitizePath('C:\\Program Files\\My App\\data.pdf', ['/host']);
      expect(result).toBe('/host/Program Files/My App/data.pdf');
    });

    it('should handle Windows paths with special characters', () => {
      const result = sanitizePath('C:\\Users\\hotra\\docs (2024)\\report.pdf', ['/host']);
      expect(result).toBe('/host/Users/hotra/docs (2024)/report.pdf');
    });

    it('should translate and then reject path with traversal attempt', () => {
      // C:\Users\..\..\..\etc\passwd -> /host/Users/../../../etc/passwd
      // path.resolve should normalize this to /etc/passwd which is outside /host
      expect(() => {
        sanitizePath('C:\\Users\\..\\..\\..\\etc\\passwd', ['/host']);
      }).toThrow(ValidationError);
    });

    it('should work with /host as part of a larger allowed dirs list', () => {
      const result = sanitizePath('C:\\data\\file.pdf', ['/tmp', '/data', '/host']);
      expect(result).toBe('/host/data/file.pdf');
    });
  });
});
