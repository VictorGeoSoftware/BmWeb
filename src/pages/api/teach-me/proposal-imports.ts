import type { NextApiRequest, NextApiResponse } from 'next';
import { handleTeachUpload } from '@/lib/teach-upload-handler';

export const config = { api: { bodyParser: false, responseLimit: '16kb' } };

export default function proposalImports(req: NextApiRequest, res: NextApiResponse) {
  return handleTeachUpload(req, res, 'proposal-imports');
}
