import type { NextApiRequest, NextApiResponse } from 'next';
import { handleTeachUpload } from '@/lib/teach-upload-handler';

export const config = { api: { bodyParser: false, responseLimit: '2kb' } };

export default function productionPromotion(req: NextApiRequest, res: NextApiResponse) {
  return handleTeachUpload(req, res, 'production-promotion');
}
