import { useState, useEffect, useCallback } from 'react';

interface ComfyUIStatus {
  activeJobs: Array<{
    datetime: string;
    status: string;
    promptId: string;
    duration: number;
  }>;
  internalQueueLength: number;
  serverQueueRunning: number;
  serverQueuePending: number;
}

interface UseExitConfirmationReturn {
  isDialogOpen: boolean;
  step: 1 | 2;
  comfyUIStatus: ComfyUIStatus;
  handleConfirm: () => void;
  handleCancel: () => void;
}

export const useExitConfirmation = (): UseExitConfirmationReturn => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [comfyUIStatus, setComfyUIStatus] = useState<ComfyUIStatus>({
    activeJobs: [],
    internalQueueLength: 0,
    serverQueueRunning: 0,
    serverQueuePending: 0,
  });

  // メインプロセスからの終了確認要求を受信
  useEffect(() => {
    const handleShowExitConfirmation = (status: ComfyUIStatus) => {
      console.log('Exit confirmation requested with status:', status);
      setComfyUIStatus(status);
      setIsDialogOpen(true);
      setStep(1);
    };

    if (window.electronAPI?.onShowExitConfirmation) {
      window.electronAPI.onShowExitConfirmation(handleShowExitConfirmation);
    }

    return () => {
      if (window.electronAPI?.removeExitConfirmationListener) {
        window.electronAPI.removeExitConfirmationListener();
      }
    };
  }, []);

  const handleConfirm = useCallback(async () => {
    if (step === 1) {
      // 1回目の確認：2回目のステップに進む
      setStep(2);
    } else {
      // 2回目の確認：実際に終了
      setIsDialogOpen(false);
      if (window.electronAPI?.confirmExit) {
        await window.electronAPI.confirmExit(true);
      }
    }
  }, [step]);

  const handleCancel = useCallback(async () => {
    // キャンセル：ダイアログを閉じて終了をキャンセル
    setIsDialogOpen(false);
    setStep(1);
    if (window.electronAPI?.confirmExit) {
      await window.electronAPI.confirmExit(false);
    }
  }, []);

  return {
    isDialogOpen,
    step,
    comfyUIStatus,
    handleConfirm,
    handleCancel,
  };
};