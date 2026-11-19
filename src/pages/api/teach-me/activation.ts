import type { NextApiRequest, NextApiResponse } from 'next';
import { handleTeachUpload } from '@/lib/teach-upload-handler';

export const config = { api: { bodyParser: false, responseLimit: '4kb' } };

export default function activation(req: NextApiRequest, res: NextApiResponse) {
  return handleTeachUpload(req, res, 'activation');
}
