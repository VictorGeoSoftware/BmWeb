import type { NextApiRequest, NextApiResponse } from 'next';
import { handleTeachUpload } from '@/lib/teach-upload-handler';

export const config = { api: { bodyParser: false } };

export default function messages(req: NextApiRequest, res: NextApiResponse) {
  return handleTeachUpload(req, res, 'messages');
}
