import PdfUpload from '@/components/pdf-upload';

export default function DashboardPage() {
  return (
    <>
      <header className="mb-8">
        <h1 className="text-3xl font-bold font-headline">Upload Price Proposal</h1>
        <p className="text-muted-foreground">
          Upload a PDF document with the latest electricity prices.
        </p>
      </header>
      <PdfUpload />
    </>
  );
}
