import { BaseJob, QueueMetrics, QueueOptions, CircuitBreaker } from '@/types/queues/base-processing-queue';
import { createRedisClient, redis } from '@config/redis';
import { EventEmitter } from 'events';
import { emitJobUpdate } from '@/config/socket';
import os from 'os';
import IORedis from 'ioredis';
import { Worker } from 'worker_threads';
import { 
    QueueEventBus, 
    JobStateManager, 
    JobLifecycleManager, 
    WorkerPoolManager, 
    JobStatusManager,
    WorkerPoolConfig,
    RetryConfig
} from './components';

export abstract class BaseProcessingQueue<T extends BaseJob> extends EventEmitter {
    protected readonly queueName: string;
    protected readonly workerPath: string;
    protected readonly queueKey: string;
    protected readonly processingKey: string;
    protected readonly statusKeyPrefix: string;
    protected readonly priorityQueueKey: string;
    protected readonly maxConcurrentJobs: number;
    protected readonly cpuLoadThreshold: number;
    protected readonly ramLoadThreshold: number;
    protected readonly workerIdleTimeout: number;
    protected readonly jobTimeout: number;
    protected readonly enableMetrics: boolean;
    protected readonly healthCheckInterval: number;
    protected readonly gracefulShutdownTimeout: number;
    protected readonly numCpus: number;
    protected readonly useStreamingAdd: boolean;
    
    // Component managers
    protected eventBus!: QueueEventBus;
    protected jobStateManager!: JobStateManager;
    protected jobLifecycleManager!: JobLifecycleManager;
    protected workerPoolManager!: WorkerPoolManager;
    protected jobStatusManager!: JobStatusManager;
    
    protected isShutdown = false;
    protected isPaused = false;
    protected redisListenerClient: IORedis;
    protected dispatcherPromise?: Promise<void>;
    protected healthCheckInterval_: NodeJS.Timeout | null = null;
    protected metrics: QueueMetrics;

    private sessionsBeingCleaned = new Set<string>();
    
    private readonly batchSize = 20;
    private readonly dispatchBackoff = {
        initial: 50,
        max: 5000,
        current: 50,
        multiplier: 1.5
    };

    private readonly circuitBreaker: CircuitBreaker = {
        failures: 0,
        lastFailure: 0,
        threshold: 5,
        timeout: 30000,
        isOpen(): boolean {
            return this.failures >= this.threshold && 
                   (Date.now() - this.lastFailure) < this.timeout;
        },
        recordFailure(): void {
            this.failures++;
            this.lastFailure = Date.now();
        },
        reset(): void {
            this.failures = 0;
        }
    };

    constructor(options: QueueOptions){
        super();
        
        this.queueName = options.queueName;
        this.workerPath = options.workerPath;
        this.queueKey = `${this.queueName}_queue`;
        this.processingKey = `${this.queueKey}:processing`;
        this.statusKeyPrefix = `${this.queueKey}:status:`;
        this.priorityQueueKey = `${this.queueKey}:priority`;
        this.maxConcurrentJobs = options.maxConcurrentJobs || Math.max(2, Math.floor(os.cpus().length * 0.75));
        this.cpuLoadThreshold = options.cpuLoadThreshold || 85;
        this.useStreamingAdd = options.useStreamingAdd || false;
        this.ramLoadThreshold = options.ramLoadThreshold || 90;
        this.workerIdleTimeout = options.workerIdleTimeout || 300000;
        this.jobTimeout = options.jobTimeout || 900000;
        this.enableMetrics = options.enableMetrics !== false;
        this.healthCheckInterval = options.healthCheckInterval || 30000;
        this.gracefulShutdownTimeout = options.gracefulShutdownTimeout || 30000; 
        this.numCpus = os.cpus().length;
        this.redisListenerClient = createRedisClient();

        this.metrics = {
            totalJobsProcessed: 0,
            totalJobsFailed: 0,
            averageProcessingTimeMs: 0,
            peakMemoryUsageMB: 0,
            workerRestarts: 0,
            lastHealthCheck: new Date().toISOString()
        };

        this.initializeComponents();
        this.initializeQueue();
    }

    private initializeComponents(): void {
        // Initialize component managers
        this.eventBus = QueueEventBus.getInstance();
        this.jobStateManager = JobStateManager.getInstance();
        
        const retryConfig: RetryConfig = {
            maxRetries: 3,
            retryDelay: 1000,
            backoffMultiplier: 2,
            maxRetryDelay: 30000
        };
        this.jobLifecycleManager = JobLifecycleManager.getInstance(retryConfig);
        
        const workerPoolConfig: WorkerPoolConfig = {
            workerPath: this.workerPath,
            maxWorkers: this.maxConcurrentJobs,
            workerIdleTimeout: this.workerIdleTimeout,
            cleanupInterval: this.workerIdleTimeout / 3
        };
        this.workerPoolManager = WorkerPoolManager.getInstance(this.queueName, workerPoolConfig);
        
        this.jobStatusManager = JobStatusManager.getInstance(this.statusKeyPrefix);
        
        this.setupComponentEventListeners();
    }

    private setupComponentEventListeners(): void {
        // Listen for job lifecycle events
        this.eventBus.onJobCompleted((event) => {
            this.updateMetrics(this.calculateProcessingTime(event.jobId), false);
            this.emit('jobCompleted', { 
                job: this.jobStateManager.getJobState(event.jobId)?.job, 
                result: event.payload.result, 
                processingTime: this.calculateProcessingTime(event.jobId) 
            });
            this.checkAndCleanupSession(event.jobId);
        });

        this.eventBus.onJobFailed((event) => {
            this.updateMetrics(this.calculateProcessingTime(event.jobId), true);
            this.emit('jobFailed', { 
                job: this.jobStateManager.getJobState(event.jobId)?.job, 
                error: event.payload.error, 
                processingTime: this.calculateProcessingTime(event.jobId) 
            });
        });

        this.eventBus.onJobProgress((event) => {
            this.emit('jobProgress', { 
                job: this.jobStateManager.getJobState(event.jobId)?.job, 
                progress: event.payload.progress 
            });
        });

        this.eventBus.onJobRetry((event) => {
            const jobState = this.jobStateManager.getJobState(event.jobId);
            if (jobState) {
                this.emit('jobRetry', { 
                    job: jobState.job, 
                    error: event.payload.error, 
                    attempt: event.payload.retryCount 
                });
            }
        });

        // Listen for job requeue events
        this.eventBus.on('job:requeue', (event) => {
            this.handleJobRequeue(event.payload.job, event.payload.rawData);
        });

        // Listen for worker events
        this.eventBus.onWorkerTerminated((event) => {
            this.metrics.workerRestarts++;
            this.handleWorkerFailure(event.workerId);
        });

        this.eventBus.onWorkerError((event) => {
            this.handleWorkerFailure(event.workerId);
        });
    }

    private calculateProcessingTime(jobId: string): number {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState || !jobState.startTime) {
            return 0;
        }
        return Date.now() - jobState.startTime;
    }

    private async initializeQueue(): Promise<void> {
        try{
            console.log(`[${this.queueName}] Initializing optimized queue...`);
            
            this.startDispatchingJobs();
            
            if(this.enableMetrics){
                this.startHealthChecking();
            }
            
            this.setupGracefulShutdown();
            
            console.log(`[${this.queueName}] Queue initialization complete.`);
        }catch(error){
            console.error(`[${this.queueName}] Failed to initialize queue:`, error);
            throw error;
        }
    }

    private async startDispatchingJobs(): Promise<void> {
        this.dispatcherPromise = this.dispatchLoop();
    }

    private async dispatchLoop(): Promise<void> {
        console.log(`[${this.queueName}] High-performance dispatcher started.`);
        
        while(!this.isShutdown){
            try{
                if(this.isPaused){
                    await this.sleep(1000);
                    continue;
                }

                if(this.circuitBreaker.isOpen()){
                    await this.sleep(this.circuitBreaker.timeout / 10);
                    continue;
                }

                const loadCheck = this.isServerOverloaded();
                if(loadCheck.overloaded){
                    await this.sleep(this.dispatchBackoff.current);
                    this.dispatchBackoff.current = Math.min(
                        this.dispatchBackoff.current * this.dispatchBackoff.multiplier, 
                        this.dispatchBackoff.max
                    );
                    continue;
                }

                const availableWorkers = this.workerPoolManager.getStatus().idleWorkers;
                if(availableWorkers === 0){
                    await this.sleep(100);
                    continue;
                }

                const jobsToProcess = Math.min(availableWorkers, this.batchSize);
                const jobs = await this.getJobsFromQueues(jobsToProcess);

                if(jobs.length === 0){
                    this.dispatchBackoff.current = Math.min(
                        this.dispatchBackoff.current * 1.2, 
                        this.dispatchBackoff.max
                    );
                    await this.sleep(this.dispatchBackoff.current);
                    continue;
                }

                this.dispatchBackoff.current = this.dispatchBackoff.initial;
                this.circuitBreaker.reset();

                const promises: Promise<void>[] = [];
                for(const rawData of jobs){
                    if(this.isShutdown) break;
                    
                    try{
                        const job = this.deserializeJob(rawData);
                        promises.push(this.dispatchJobToWorker(job, rawData));
                    }catch(error){
                        await this.handleFailedJobDispatch(rawData, error);
                    }
                }

                await Promise.allSettled(promises);
                await this.sleep(25);

            } catch(err){
                if(this.isShutdown || (err instanceof Error && err.message.includes('Connection is closed'))){
                    break;
                }

                this.circuitBreaker.recordFailure();
                console.error(`[${this.queueName}] Dispatcher error:`, err);
                await this.sleep(Math.min(this.circuitBreaker.failures * 1000, 10000));
            }
        }
        
        console.log(`[${this.queueName}] Dispatcher stopped.`);
    }

    private async getJobsFromQueues(count: number): Promise<string[]> {
        const jobs: string[] = [];
        
        const priorityJobs = await this.getJobsFromQueue(this.priorityQueueKey, Math.min(count, 5));
        jobs.push(...priorityJobs);
        
        if(jobs.length < count){
            const regularJobs = await this.getJobsFromQueue(this.queueKey, count - jobs.length);
            jobs.push(...regularJobs);
        }
        
        return jobs;
    }

    private async getJobsFromQueue(queueKey: string, count: number): Promise<string[]> {
        const jobs: string[] = [];
        const pipeline = redis!.pipeline();
        
        for(let i = 0; i < count; i++){
            pipeline.blmove(queueKey, this.processingKey, 'RIGHT', 'LEFT', 0.1);
        }
        
        try{
            const results = await pipeline.exec();
            if(results){
                for(const result of results){
                    if(result && result[1] && typeof result[1] === 'string'){
                        jobs.push(result[1]);
                    }
                }
            }
        }catch(error){
            console.error(`[${this.queueName}] Redis pipeline error:`, error);
        }
        
        return jobs;
    }

    private async handleFailedJobDispatch(rawData: string, error: any): Promise<void> {
        try{
            await redis!.multi()
                .lpush(this.queueKey, rawData)
                .lrem(this.processingKey, 1, rawData)
                .exec();
        } catch(moveError){
            console.error(`[${this.queueName}] Critical: Failed to return job to queue:`, moveError);
        }
    }

    private async dispatchJobToWorker(job: T, rawData: string): Promise<void> {
        const availableWorkerItem = this.workerPoolManager.getAvailableWorker();
        
        if(!availableWorkerItem){
            await redis!.multi()
                .lpush(this.queueKey, rawData)
                .lrem(this.processingKey, 1, rawData)
                .exec();
            return;
        }

        const workerId = availableWorkerItem.worker.threadId!;
        
        // Add job to state manager
        this.jobStateManager.addJob(job, rawData);
        
        // Assign worker
        if (!this.jobStateManager.assignWorker(job.jobId, workerId)) {
            console.error(`[${this.queueName}] Failed to assign worker ${workerId} to job ${job.jobId}`);
            return;
        }
        
        // Update worker pool manager
        this.workerPoolManager.assignWorker(workerId, job.jobId);
        
        // Set up job timeout
        const timeout = setTimeout(() => {
            this.jobLifecycleManager.timeoutJob(job.jobId, workerId);
        }, this.jobTimeout);
        
        this.workerPoolManager.addTimeout(workerId, timeout);
        
        try{
            // Set up worker message handler if not already set
            this.setupWorkerMessageHandler(availableWorkerItem.worker);
            
            availableWorkerItem.worker.postMessage({ job });
        }catch(error){
            this.workerPoolManager.clearWorkerTimeouts(availableWorkerItem);
            this.workerPoolManager.releaseWorker(workerId);
            this.jobStateManager.releaseWorker(workerId);
            throw error;
        }
    }

    private setupWorkerMessageHandler(worker: Worker): void {
        // Prevent multiple listeners on the same worker
        if ((worker as any)._hasMessageHandler) {
            return;
        }
        
        (worker as any)._hasMessageHandler = true;
        worker.on('message', (message: any) => this.handleWorkerMessage(worker.threadId!, message));
    }

    private async handleWorkerMessage(workerId: number, message: any): Promise<void>{
        const jobState = this.jobStateManager.getJobByWorkerId(workerId);
        if(!jobState) return;

        const { job, rawData } = jobState;
        
        switch(message.status){
            case 'completed':
                this.jobLifecycleManager.completeJob(job.jobId, workerId, message.result);
                await this.removeJobFromProcessing(rawData);
                this.workerPoolManager.releaseWorker(workerId);
                break;

            case 'failed':
                this.jobLifecycleManager.failJob(job.jobId, workerId, message.error);
                await this.removeJobFromProcessing(rawData);
                this.workerPoolManager.releaseWorker(workerId);
                break;
            
            case 'progress':
                this.jobLifecycleManager.updateJobProgress(job.jobId, workerId, message.progress);
                return; // Don't release worker for progress updates
        }
    }

    private async removeJobFromProcessing(rawData: string): Promise<void> {
        try {
            await redis!.lrem(this.processingKey, 1, rawData);
        } catch (error) {
            console.error(`[${this.queueName}] Failed to remove job from processing:`, error);
        }
    }

    private handleWorkerFailure(workerId: number): void {
        const jobId = this.jobStateManager.releaseWorker(workerId);
        if (jobId) {
            const jobState = this.jobStateManager.getJobState(jobId);
            if (jobState) {
                this.handleJobRequeue(jobState.job, jobState.rawData);
            }
        }
    }

    private async handleJobRequeue(job: BaseJob, rawData: string): Promise<void> {
        try{
            await redis!.multi()
                .lpush(this.queueKey, rawData)
                .lrem(this.processingKey, 1, rawData)
                .exec();
            
            console.log(`[${this.queueName}] Requeued job ${job.jobId}`);
        }catch(error){
            console.error(`[${this.queueName}] Failed to requeue job:`, error);
        }
    }





    private async checkAndCleanupSession(jobId: string): Promise<void> {
        const jobState = this.jobStateManager.getJobState(jobId);
        if (!jobState) return;
        
        const sessionId = jobState.sessionId;
        const trajectoryId = jobState.trajectoryId;
        const teamId = jobState.teamId;
        
        if(!sessionId || !trajectoryId || !teamId) {
            console.log(`Job ${jobId} has no session info, skipping session cleanup`);
            return;
        }

        if(this.sessionsBeingCleaned.has(sessionId)) {
            console.log(`Session ${sessionId} is already being cleaned, skipping`);
            return;
        }

        console.log(`Checking session completion for ${sessionId}`);

        try {
            const luaScript = `
                local sessionId = ARGV[1]
                local trajectoryId = ARGV[2]
                local teamId = ARGV[3]
                local statusKeyPrefix = ARGV[4]
                
                local sessionKey = "session:" .. sessionId
                local counterKey = sessionKey .. ":remaining"
                local teamJobsKey = "team:" .. teamId .. ":jobs"
                
                local remaining = redis.call('DECR', counterKey)
                
                if remaining <= 0 then
                    -- Obtener datos de sesión
                    local sessionData = redis.call('GET', sessionKey)
                    if not sessionData then
                        return {0, 0, "no_session"}
                    end
                    
                    local allJobIds = redis.call('SMEMBERS', teamJobsKey)
                    local sessionJobIds = {}
                    
                    for i = 1, #allJobIds do
                        local jobStatusKey = statusKeyPrefix .. allJobIds[i]
                        local jobStatusData = redis.call('GET', jobStatusKey)
                        
                        if jobStatusData then
                            local jobStatus = cjson.decode(jobStatusData)
                            if jobStatus.sessionId == sessionId and jobStatus.trajectoryId == trajectoryId then
                                table.insert(sessionJobIds, allJobIds[i])
                            end
                        end
                    end
                    
                    redis.call('DEL', sessionKey)
                    redis.call('DEL', counterKey)
                    
                    for i = 1, #sessionJobIds do
                        redis.call('DEL', statusKeyPrefix .. sessionJobIds[i])
                        redis.call('SREM', teamJobsKey, sessionJobIds[i])
                    end
                    
                    return {1, #sessionJobIds, "cleaned"}
                else
                    return {0, remaining, "pending"}
                end
            `;

            const result = await redis!.eval(
                luaScript, 
                0, 
                sessionId, 
                trajectoryId, 
                teamId, 
                this.statusKeyPrefix
            ) as [number, number, string];

            const [shouldClean, count, status] = result;

            if(shouldClean === 1) {
                this.sessionsBeingCleaned.add(sessionId);
                
                console.log(`Session ${sessionId} CLEANED! Deleted ${count} jobs`);
                
                console.log(`Emitting session_expired event for team ${teamId}`);
                this.emitSessionExpired(teamId, sessionId, trajectoryId);
                
                setTimeout(() => {
                    this.sessionsBeingCleaned.delete(sessionId);
                }, 10000);
                
            } else if(status === "pending") {
                console.log(`Job ${jobId} finished. ${count} jobs still pending in session ${sessionId}`);
            } else {
                console.log(`Session ${sessionId} status: ${status}`);
            }

        } catch(error) {
            console.error(`Error checking session ${sessionId}:`, error);
            this.sessionsBeingCleaned.delete(sessionId);
        }
    }

    private emitSessionExpired(teamId: string, sessionId: string, trajectoryId: string): void {
        const expiredEvent = {
            type: 'session_expired',
            sessionId,
            trajectoryId,
            timestamp: new Date().toISOString()
        };
        
        emitJobUpdate(teamId, expiredEvent);
        console.log(`Session expired event emitted to team ${teamId}`);
    }



    public async addJobs(jobs: T[]): Promise<void> {
        if(jobs.length === 0) return;

        const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const sessionStartTime = new Date().toISOString();
        console.log(`Starting new job session: ${sessionId} with ${jobs.length} jobs`);

        const jobsWithSession = jobs.map(job => ({
            ...job,
            sessionId,
            sessionStartTime
        }));

        const sessionKey = `session:${sessionId}`;
        const counterKey = `session:${sessionId}:remaining`;
        
        const pipeline = redis!.pipeline();
        
        pipeline.setex(sessionKey, 86400 * 7, JSON.stringify({
            sessionId,
            startTime: sessionStartTime,
            totalJobs: jobs.length,
            trajectoryId: (jobs[0] as any).trajectoryId,
            teamId: (jobs[0] as any).teamId,
            status: 'active'
        }));
        
        pipeline.set(counterKey, jobs.length.toString());
        pipeline.expire(counterKey, 86400 * 7);
        
        await pipeline.exec();
        
        console.log(`Session counter initialized: ${jobs.length} jobs remaining for session ${sessionId}`);

        if(this.useStreamingAdd){
            console.log(`[${this.queueName}] Adding ${jobs.length} jobs to queue using streaming mode...`);
            for(let i = 0; i < jobsWithSession.length; i++){
                const job = jobsWithSession[i];
                const stringifiedJob = JSON.stringify(job);
                await redis!.lpush(this.queueKey, stringifiedJob);

                // Add job to state manager
                this.jobStateManager.addJob(job as T, stringifiedJob, sessionId);

                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            console.log(`[${this.queueName}] Successfully added all jobs via streaming.`);
        }else{
            console.log(`[${this.queueName}] Adding ${jobs.length} jobs to queue using batch mode...`);

            const queuePipeline = redis!.pipeline();
            const priorityJobs: string[] = [];
            const regularJobs: string[] = [];
            
            for(const job of jobsWithSession){
                const serialized = JSON.stringify(job);
                
                if(job.priority && job.priority > 5){
                    priorityJobs.push(serialized);
                } else {
                    regularJobs.push(serialized);
                }
                
                // Add job to state manager  
                this.jobStateManager.addJob(job as T, serialized, sessionId);
            }
            
            if(priorityJobs.length > 0){
                queuePipeline.lpush(this.priorityQueueKey, ...priorityJobs);
            }
            if(regularJobs.length > 0){
                queuePipeline.lpush(this.queueKey, ...regularJobs);
            }
            
            await queuePipeline.exec();

            this.emit('jobsAdded', { 
                count: jobs.length, 
                priority: priorityJobs.length, 
                regular: regularJobs.length 
            });

            console.log(`[${this.queueName}] Added ${jobs.length} jobs (${priorityJobs.length} priority, ${regularJobs.length} regular) with session ${sessionId}`);
        }

        console.log(`Job session ${sessionId} created with atomic counter tracking`);
    }



    protected abstract deserializeJob(rawData: string): T;



    private startHealthChecking(): void {
        this.healthCheckInterval_ = setInterval(async () => {
            try{
                await this.performHealthCheck();
            }catch(error){
                console.error(`[${this.queueName}] Health check failed:`, error);
            }
        }, this.healthCheckInterval);
    }

    private async performHealthCheck(): Promise<void> {
        const currentMemory = process.memoryUsage().heapUsed / 1024 / 1024;
        this.metrics.peakMemoryUsageMB = Math.max(this.metrics.peakMemoryUsageMB, currentMemory);
        this.metrics.lastHealthCheck = new Date().toISOString();
        
        // Check for jobs approaching timeout using the new job state manager
        const activeJobs = this.jobLifecycleManager.getActiveJobs();
        const now = Date.now();
        
        for(const jobState of activeJobs){
            if(jobState.startTime){
                const processingTime = now - jobState.startTime;
                if(processingTime > this.jobTimeout * 0.9){
                    console.warn(`[${this.queueName}] Job ${jobState.jobId} on worker #${jobState.workerId} approaching timeout`);
                }
            }
        }
        
        // Emit health check with combined metrics from lifecycle manager
        const lifecycleMetrics = this.jobLifecycleManager.getMetrics();
        const combinedMetrics = {
            ...this.metrics,
            ...lifecycleMetrics
        };
        
        this.eventBus.emitSystemHealthCheck(combinedMetrics, this.queueName);
        this.emit('healthCheck', combinedMetrics);
    }

    private updateMetrics(processingTime: number, failed: boolean): void {
        if(!this.enableMetrics) return;
        
        if(failed){
            this.metrics.totalJobsFailed++;
        } else {
            this.metrics.totalJobsProcessed++;
        }
        
        const totalJobs = this.metrics.totalJobsProcessed + this.metrics.totalJobsFailed;
        this.metrics.averageProcessingTimeMs = 
            (this.metrics.averageProcessingTimeMs * (totalJobs - 1) + processingTime) / totalJobs;
    }

    public async getStatus(){
        try{
            const results = await redis!.multi()
                .llen(this.queueKey)
                .llen(this.processingKey)
                .llen(this.priorityQueueKey)
                .exec();

            const pendingJobs = (results?.[0]?.[1] as number) || 0;
            const processingJobs = (results?.[1]?.[1] as number) || 0;
            const priorityJobs = (results?.[2]?.[1] as number) || 0;
            
            // Get worker status from worker pool manager
            const workerStatus = this.workerPoolManager.getStatus();
            const serverLoad = this.isServerOverloaded();

            return {
                queueName: this.queueName,
                maxConcurrent: this.maxConcurrentJobs,
                activeWorkers: workerStatus.activeWorkers,
                totalWorkers: workerStatus.totalWorkers,
                pendingJobs: pendingJobs + priorityJobs,
                processingJobs,
                priorityJobs,
                serverLoad,
                metrics: this.enableMetrics ? this.metrics : null,
                isPaused: this.isPaused,
                circuitBreaker: {
                    isOpen: this.circuitBreaker.isOpen(),
                    failures: this.circuitBreaker.failures
                },
                workerDetails: workerStatus.workers
            };
        }catch(error){
            console.error(`[${this.queueName}] Failed to get status:`, error);
            return null;
        }
    }

    private isServerOverloaded(): { overloaded: boolean, cpu: number, ram: number } {
        const loadAvg = os.loadavg()[0];
        const cpuUsage = (loadAvg / this.numCpus) * 100;
        
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const ramUsage = (usedMem / totalMem) * 100;
        
        const overloaded = cpuUsage > this.cpuLoadThreshold || ramUsage > this.ramLoadThreshold;

        return { 
            overloaded, 
            cpu: Math.round(cpuUsage * 100) / 100, 
            ram: Math.round(ramUsage * 100) / 100
        };
    }

    public pause(): void {
        this.isPaused = true;
        console.log(`[${this.queueName}] Queue paused`);
        this.emit('paused');
    }

    public resume(): void {
        this.isPaused = false;
        console.log(`[${this.queueName}] Queue resumed`);
        this.emit('resumed');
    }

    private setupGracefulShutdown(): void {
        const shutdown = async (signal: string) => {
            console.log(`[${this.queueName}] Received ${signal}, initiating graceful shutdown...`);
            await this.shutdown();
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }

    public async shutdown(): Promise<void> {
        console.log(`[${this.queueName}] Starting graceful shutdown...`);
        
        this.isShutdown = true;
        this.emit('shutdown');
        
        if(this.healthCheckInterval_){
            clearInterval(this.healthCheckInterval_);
        }
        
        // Wait for active jobs to complete using the new job state manager
        const shutdownStart = Date.now();
        while(this.jobStateManager.getJobsByStatus('running').length > 0 && 
              (Date.now() - shutdownStart) < this.gracefulShutdownTimeout){
            console.log(`[${this.queueName}] Waiting for ${this.jobStateManager.getJobsByStatus('running').length} jobs to complete...`);
            await this.sleep(1000);
        }
        
        // Shutdown worker pool manager
        await this.workerPoolManager.shutdown();
        
        // Cleanup job state manager
        this.jobStateManager.cleanup();
        
        this.redisListenerClient.disconnect();
        
        console.log(`[${this.queueName}] Graceful shutdown complete.`);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}