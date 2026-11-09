import React, { useCallback, useState } from 'react';
import { Upload, X } from 'lucide-react';
import { Button } from './Button';
import styles from './FileDropzone.module.css';

export interface FileDropzoneProps {
  className?: string;
  accept?: string;
  maxFiles?: number;
  maxSize?: number; // in bytes
  onFilesSelected?: (files: File[]) => void;
  disabled?: boolean;
  /** M10/R11: operação em andamento (ex.: enviando). Mantém o texto de status legível (a área segue desabilitada; só ícone e borda ficam esmaecidos) e o anuncia aos leitores de tela por região viva (`aria-live`). Sem `aria-busy`: com ele o leitor de tela ADIA os anúncios da região enquanto durar o envio. */
  busy?: boolean;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
}

export const FileDropzone: React.FC<FileDropzoneProps> = ({
  className = '',
  accept,
  maxFiles = 1,
  maxSize,
  onFilesSelected,
  disabled = false,
  busy,
  icon = <Upload size={48} />,
  title = "Clique para enviar ou arraste e solte",
  subtitle,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (disabled) return;
    
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragging(true);
    } else if (e.type === "dragleave") {
      setIsDragging(false);
    }
  }, [disabled]);

  const validateFiles = useCallback((fileList: FileList | null): File[] => {
    if (!fileList) return [];
    
    const files = Array.from(fileList);
    
    if (files.length > maxFiles) {
      setError(maxFiles === 1 ? "Selecione apenas um arquivo." : `Selecione no máximo ${maxFiles} arquivos.`);
      return [];
    }

    if (accept) {
      const acceptedTypes = accept.split(',').map(type => type.trim());
      const invalidFiles = files.filter(file => 
        !acceptedTypes.some(type => {
          if (type.startsWith('.')) {
            return file.name.toLowerCase().endsWith(type.toLowerCase());
          }
          return file.type.match(new RegExp(type.replace('*', '.*')));
        })
      );
      
      if (invalidFiles.length > 0) {
        setError("Tipo de arquivo não permitido. Selecione um formato aceito.");
        return [];
      }
    }

    if (maxSize) {
      const oversizedFiles = files.filter(file => file.size > maxSize);
      if (oversizedFiles.length > 0) {
        setError(`O arquivo excede o limite de ${Math.round(maxSize / 1024 / 1024)} MB.`);
        return [];
      }
    }

    setError(null);
    return files;
  }, [accept, maxFiles, maxSize]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (disabled) return;
    
    setIsDragging(false);
    
    const files = validateFiles(e.dataTransfer.files);
    if (files.length > 0 && onFilesSelected) {
      onFilesSelected(files);
    }
  }, [disabled, validateFiles, onFilesSelected]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (disabled) return;
    
    const files = validateFiles(e.target.files);
    if (files.length > 0 && onFilesSelected) {
      onFilesSelected(files);
    }
    // Reset input value to allow selecting the same file again
    e.target.value = '';
  }, [disabled, validateFiles, onFilesSelected]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const defaultSubtitle = (accept || maxFiles > 1) && (
    <>
      {accept && `Tipos aceitos: ${accept}`}
      {maxFiles > 1 && ` (até ${maxFiles} arquivos)`}
    </>
  );

  return (
    <div className={`${styles.container} ${className ?? ""}`}>
      <label
        className={`
          ${styles.dropzone}
          ${isDragging ? styles.dragging : ''}
          ${disabled ? styles.disabled : ''}
          ${busy ? styles.busy : ''}
        `}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input
          type="file"
          onChange={handleFileInput}
          accept={accept}
          multiple={maxFiles > 1}
          disabled={disabled}
          aria-label="Enviar arquivo"
        />
        
        <span className={styles.icon}>{icon}</span>
        <span className={styles.title} aria-live={busy === undefined ? undefined : "polite"}>{title}</span>
        {(subtitle || defaultSubtitle) && (
          <span className={styles.subtitle}>{subtitle || defaultSubtitle}</span>
        )}
      </label>

      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={clearError}
            aria-label="Fechar aviso de erro"
          >
            <X size={16} />
          </Button>
        </div>
      )}
    </div>
  );
};
