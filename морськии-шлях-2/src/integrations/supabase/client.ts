import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://fazllooloatqhkbtvgpj.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_PX5l3GV1laeV-tvR6ao0jg_vQKxj2ah';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
