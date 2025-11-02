import express from 'express';
import { JobController } from './controllers/job.controller';
 
const app = express();
app.use(express.json());
app.use('/job', JobController);
 
export default app;
