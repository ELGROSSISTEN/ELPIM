export type BackgroundActivityRegisterPayload = {
  jobIds: string[];
  silent?: boolean;
};

export type BackgroundActivityOptions = {
  silent?: boolean; // when true, job is tracked internally but NOT shown in the panel
};

const EVENT_NAME = 'epim:background-activity-register';

export const registerBackgroundActivityJobs = (jobIds: string[], options?: BackgroundActivityOptions): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const filtered = jobIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (!filtered.length) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<BackgroundActivityRegisterPayload>(EVENT_NAME, {
      detail: { jobIds: filtered, silent: options?.silent ?? false },
    }),
  );
};

export const backgroundActivityEventName = EVENT_NAME;
