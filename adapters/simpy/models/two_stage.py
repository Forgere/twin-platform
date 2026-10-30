import simpy


def run(env, rng, params, until):
    """两段工位：到料 → 加工 → 检测。

    只用注入的 `rng`，不用全局 random / 挂钟；环境由执行器注入，
    因此 `simpy.Resource` 与 `simpy.Environment` 自带事件追踪。
    """
    machines = simpy.Resource(env, capacity=params.get("machineCapacity", 2))
    inspectors = simpy.Resource(env, capacity=params.get("inspectorCapacity", 1))
    arrival_mean = params.get("arrivalMean", 5)
    process_mean = params.get("processMean", 7)
    inspect_mean = params.get("inspectMean", 3)
    state = {"created": 0, "completed": 0}

    def job(name):
        with machines.request() as request:
            yield request
            yield env.timeout(rng.expovariate(1.0 / process_mean))
        with inspectors.request() as request:
            yield request
            yield env.timeout(rng.expovariate(1.0 / inspect_mean))
        state["completed"] += 1

    def arrivals():
        while True:
            yield env.timeout(rng.expovariate(1.0 / arrival_mean))
            if env.now >= until:
                break
            state["created"] += 1
            env.process(job(f"job-{state['created']}"))

    env.process(arrivals())
    env.run(until=until)
    return {"created": state["created"], "completed": state["completed"], "now": env.now}
