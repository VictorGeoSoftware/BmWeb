import type { NextApiRequest, NextApiResponse } from 'next';
import { handleTeachUpload } from '@/lib/teach-upload-handler';

export const config = { api: { bodyParser: false, responseLimit: '2kb' } };

export default function proposalValidation(req: NextApiRequest, res: NextApiResponse) {
  return handleTeachUpload(req, res, 'proposal-validation');
}
