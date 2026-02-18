"use client";

import React, { useState, DragEvent } from 'react';
import { UploadCloud, File as FileIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Progress } from '@/components/ui/progress';

export default function PdfUpload() {
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const { toast } = useToast();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const handleFiles = (newFiles: FileList | null) => {
    if (!newFiles) return;
    const pdfFiles = Array.from(newFiles).filter(file => file.type === 'application/pdf');
    if (pdfFiles.length !== newFiles.length) {
      toast({
        variant: 'destructive',
        title: 'Invalid file type',
        description: 'Please upload only PDF documents.',
      });
    }
    setFiles(pdfFiles.slice(0, 1)); // Limit to one file
  }

  const handleDrag = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
  };

  const removeFile = (file: File) => {
    setFiles(files.filter(f => f !== file));
    if (inputRef.current) {
        inputRef.current.value = "";
    }
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      toast({
        variant: 'destructive',
        title: 'No file selected',
        description: 'Please select a PDF file to upload.',
      });
      return;
    }
    setIsUploading(true);
    setUploadProgress(0);

    const interval = setInterval(() => {
      setUploadProgress(prev => (prev >= 95 ? prev : prev + 5));
    }, 120);

    try {
      const formData = new FormData();
      formData.append('file', files[0]);

      const response = await fetch('/api/price-proposal/upload', {
        method: 'POST',
        body: formData,
      });

      const responseText = await response.text();
      const payload = responseText ? JSON.parse(responseText) : {};

      if (!response.ok) {
        throw new Error(payload?.message ?? 'Upload failed');
      }

      setUploadProgress(100);

      toast({
        title: 'Upload successful',
        description: `${files[0].name} has been processed and stored.`,
      });

      console.log('Price proposal upload response:', payload);

      setFiles([]);
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected upload error';
      toast({
        variant: 'destructive',
        title: 'Upload failed',
        description: message,
      });
      console.error('Upload price proposal failed:', error);
    } finally {
      clearInterval(interval);
      setIsUploading(false);
      setUploadProgress(0);
    }
  };
  
  const onButtonClick = () => {
    inputRef.current?.click();
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        onClick={onButtonClick}
        className={cn(
          "flex flex-col items-center justify-center w-full h-64 border-2 border-dashed rounded-lg cursor-pointer transition-colors",
          isDragActive ? 'border-primary bg-accent/10' : 'border-border hover:border-primary/50'
        )}
      >
        <input ref={inputRef} type="file" className="hidden" accept="application/pdf" multiple={false} onChange={handleInputChange} />
        <div className="flex flex-col items-center justify-center pt-5 pb-6 text-center pointer-events-none">
          <UploadCloud className={cn("w-10 h-10 mb-4 text-muted-foreground", isDragActive && "text-primary")} />
          <p className="mb-2 text-sm text-muted-foreground">
            <span className="font-semibold text-primary">Click to upload</span> or drag and drop
          </p>
          <p className="text-xs text-muted-foreground">PDF only, up to 10MB</p>
        </div>
      </div>

      {files.length > 0 && (
        <div className="mt-6">
          <h3 className="text-lg font-medium mb-2">Selected file:</h3>
          <ul>
            {files.map((file, i) => (
              <li key={i} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                <div className="flex items-center gap-3 overflow-hidden">
                  <FileIcon className="h-6 w-6 text-primary flex-shrink-0" />
                  <span className="text-sm font-medium truncate">{file.name}</span>
                </div>
                <Button variant="ghost" size="icon" onClick={() => removeFile(file)} disabled={isUploading}>
                  <X className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isUploading && (
        <div className="mt-6">
          <Progress value={uploadProgress} className="w-full" />
          <p className="text-sm text-center mt-2 text-muted-foreground">Uploading... {uploadProgress}%</p>
        </div>
      )}

      <div className="mt-8 flex justify-end">
        <Button onClick={handleUpload} disabled={files.length === 0 || isUploading} style={{backgroundColor: 'var(--accent)', color: 'var(--accent-foreground)'}}>
          {isUploading ? 'Uploading...' : 'Upload Price Proposal'}
        </Button>
      </div>
    </div>
  );
}
