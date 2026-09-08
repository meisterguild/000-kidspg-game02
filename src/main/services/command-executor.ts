import { spawn } from 'child_process';
import * as path from 'path';

export interface ExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: number;
}

export interface MagickError {
  type: 'timeout' | 'file_not_found' | 'invalid_script' | 'permission_error' | 'unknown';
  message: string;
  details?: string;
}

export class CommandExecutor {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = 60000) {
    this.timeoutMs = timeoutMs;
  }

  async executeMagickScript(scriptPath: string): Promise<ExecutionResult> {
    const startTime = Date.now();
    
    
    try {
      const normalizedScriptPath = this.normalizePathForWindows(scriptPath);
      
      return await this.runCommand('magick', ['-script', normalizedScriptPath]);
      
    } catch (error) {
      console.error('CommandExecutor - Execution failed:', error);
      
      return {
        success: false,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
        duration: Date.now() - startTime
      };
    }
  }

  private async runCommand(command: string, args: string[]): Promise<ExecutionResult> {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      
      const process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      });

      let stdout = '';
      let stderr = '';
      let isResolved = false;

      // タイムアウト設定
      const timeoutId = setTimeout(() => {
        if (!isResolved) {
          process.kill('SIGTERM');
          
          setTimeout(() => {
            if (!process.killed) {
              process.kill('SIGKILL');
            }
          }, 5000);
          
          isResolved = true;
          resolve({
            success: false,
            stdout,
            stderr: stderr + '\nCommand timed out',
            exitCode: null,
            duration: Date.now() - startTime
          });
        }
      }, this.timeoutMs);

      // 出力監視
      process.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
      });

      process.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
      });

      // プロセス終了処理
      process.on('close', (code) => {
        if (!isResolved) {
          clearTimeout(timeoutId);
          isResolved = true;
          
          const duration = Date.now() - startTime;
          
          resolve({
            success: code === 0,
            stdout,
            stderr,
            exitCode: code,
            duration
          });
        }
      });

      process.on('error', (error) => {
        if (!isResolved) {
          clearTimeout(timeoutId);
          isResolved = true;
          
          console.error('CommandExecutor - Process error:', error);
          resolve({
            success: false,
            stdout,
            stderr: stderr + `\nProcess error: ${error.message}`,
            exitCode: null,
            duration: Date.now() - startTime
          });
        }
      });
    });
  }

  private normalizePathForWindows(filePath: string): string {
    // Windowsのパス区切り文字を統一
    return path.resolve(filePath).replace(/\\/g, '/');
  }

  parseError(stderr: string): MagickError {
    const lowerStderr = stderr.toLowerCase();
    
    if (lowerStderr.includes('timeout') || lowerStderr.includes('timed out')) {
      return {
        type: 'timeout',
        message: 'ImageMagick処理がタイムアウトしました',
        details: stderr
      };
    }
    
    if (lowerStderr.includes('no such file') || lowerStderr.includes('cannot open')) {
      return {
        type: 'file_not_found',
        message: '必要なファイルが見つかりません',
        details: stderr
      };
    }
    
    if (lowerStderr.includes('script') || lowerStderr.includes('syntax')) {
      return {
        type: 'invalid_script',
        message: 'ImageMagickスクリプトにエラーがあります',
        details: stderr
      };
    }
    
    if (lowerStderr.includes('permission') || lowerStderr.includes('access')) {
      return {
        type: 'permission_error',
        message: 'ファイルへのアクセス権限がありません',
        details: stderr
      };
    }
    
    return {
      type: 'unknown',
      message: 'ImageMagick実行中に不明なエラーが発生しました',
      details: stderr
    };
  }
}