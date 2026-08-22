interface SavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable(): Promise<{ write(blob: Blob): Promise<void>; close(): Promise<void> }>;
  }>;
}

export interface SaveDestination {
  save(blob: Blob): Promise<void>;
}

export interface SaveFileType {
  description: string;
  mimeType: string;
  extensions: string[];
}

const PLY_TYPE: SaveFileType = {
  description: '3D Gaussian Splat PLY',
  mimeType: 'application/octet-stream',
  extensions: ['.ply'],
};

/** Call this directly from a click/submit handler so native pickers retain user activation. */
export function prepareSaveFile(
  name: string,
  type: SaveFileType = PLY_TYPE,
): Promise<SaveDestination> {
  const picker = (window as SavePickerWindow).showSaveFilePicker;
  if (picker) {
    return picker
      .call(window, {
        suggestedName: name,
        types: [
          {
            description: type.description,
            accept: { [type.mimeType]: type.extensions },
          },
        ],
      })
      .then((handle) => ({
        save: async (blob: Blob): Promise<void> => {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        },
      }));
  }
  return Promise.resolve({
    save: (blob: Blob): Promise<void> => {
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      return Promise.resolve();
    },
  });
}

export async function saveFile(blob: Blob, name: string): Promise<void> {
  const destination = await prepareSaveFile(name);
  await destination.save(blob);
}
