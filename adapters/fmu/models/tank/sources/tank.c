/* 参考 FMU（FMI 2.0 Co-Simulation）：一阶水箱。

   只实现 adapter 实际调用的那组函数，用来证明"外部工业模型也能进同一条验证链"；
   它不是完整 FMI 实现（无事件模式、无状态存取、无整型/布尔变量）。
   状态更新是显式欧拉：`level += (inflow - coeff * level) * dt`，确定性、无随机。
*/

#include <stdlib.h>

#ifdef _WIN32
#define FMI2_Export __declspec(dllexport)
#else
#define FMI2_Export
#endif

typedef void *fmi2Component;
typedef int fmi2Status;
typedef double fmi2Real;
typedef unsigned int fmi2ValueReference;
typedef int fmi2Boolean;
typedef const char *fmi2String;

typedef void (*fmi2CallbackLogger)(void *, fmi2String, int, fmi2String, fmi2String);
typedef void *(*fmi2CallbackAllocateMemory)(size_t, size_t);
typedef void (*fmi2CallbackFreeMemory)(void *);
typedef void (*fmi2StepFinished)(void *, int);

typedef struct {
  fmi2CallbackLogger logger;
  fmi2CallbackAllocateMemory allocateMemory;
  fmi2CallbackFreeMemory freeMemory;
  fmi2StepFinished stepFinished;
  void *componentEnvironment;
} fmi2CallbackFunctions;

typedef struct {
  double level;
  double inflow;
  double coeff;
  double capacity;
  double time;
  int initialized;
} Tank;

#define VR_INFLOW 0u
#define VR_COEFF 1u
#define VR_LEVEL 2u
#define VR_CAPACITY 3u

FMI2_Export const char *fmi2GetTypesPlatform(void) { return "default"; }
FMI2_Export const char *fmi2GetVersion(void) { return "2.0"; }

FMI2_Export fmi2Component fmi2Instantiate(
    fmi2String instanceName, int fmuType, fmi2String guid, fmi2String resourceLocation,
    const fmi2CallbackFunctions *functions, fmi2Boolean visible, fmi2Boolean loggingOn) {
  (void)instanceName; (void)fmuType; (void)guid; (void)resourceLocation;
  (void)functions; (void)visible; (void)loggingOn;
  Tank *tank = (Tank *)calloc(1, sizeof(Tank));
  if (!tank) return NULL;
  /* 与 modelDescription.xml 的 start 值一致：adapter 也会按声明再写一遍。 */
  tank->inflow = 0.6;
  tank->coeff = 0.25;
  tank->capacity = 10.0;
  tank->level = 0.0;
  return tank;
}

FMI2_Export fmi2Status fmi2SetupExperiment(
    fmi2Component component, fmi2Boolean toleranceDefined, fmi2Real tolerance,
    fmi2Real startTime, fmi2Boolean stopTimeDefined, fmi2Real stopTime) {
  (void)toleranceDefined; (void)tolerance; (void)stopTimeDefined; (void)stopTime;
  Tank *tank = (Tank *)component;
  if (!tank) return 3;
  tank->time = startTime;
  return 0;
}

FMI2_Export fmi2Status fmi2EnterInitializationMode(fmi2Component component) {
  Tank *tank = (Tank *)component;
  if (!tank) return 3;
  tank->initialized = 1;
  return 0;
}

FMI2_Export fmi2Status fmi2ExitInitializationMode(fmi2Component component) {
  Tank *tank = (Tank *)component;
  if (!tank) return 3;
  tank->initialized = 0;
  return 0;
}

FMI2_Export fmi2Status fmi2SetReal(
    fmi2Component component, const fmi2ValueReference vr[], size_t nvr, const fmi2Real value[]) {
  Tank *tank = (Tank *)component;
  if (!tank) return 3;
  for (size_t index = 0; index < nvr; index++) {
    switch (vr[index]) {
      case VR_INFLOW: tank->inflow = value[index]; break;
      case VR_COEFF: tank->coeff = value[index]; break;
      case VR_LEVEL: tank->level = value[index]; break;
      case VR_CAPACITY: tank->capacity = value[index]; break;
      default: return 3;
    }
  }
  return 0;
}

FMI2_Export fmi2Status fmi2GetReal(
    fmi2Component component, const fmi2ValueReference vr[], size_t nvr, fmi2Real value[]) {
  Tank *tank = (Tank *)component;
  if (!tank) return 3;
  for (size_t index = 0; index < nvr; index++) {
    switch (vr[index]) {
      case VR_INFLOW: value[index] = tank->inflow; break;
      case VR_COEFF: value[index] = tank->coeff; break;
      case VR_LEVEL: value[index] = tank->level; break;
      case VR_CAPACITY: value[index] = tank->capacity; break;
      default: return 3;
    }
  }
  return 0;
}

FMI2_Export fmi2Status fmi2DoStep(
    fmi2Component component, fmi2Real currentCommunicationPoint, fmi2Real communicationStepSize,
    fmi2Boolean noSetFMUStatePriorToCurrentPoint) {
  (void)noSetFMUStatePriorToCurrentPoint;
  Tank *tank = (Tank *)component;
  if (!tank) return 3;
  tank->level += (tank->inflow - tank->coeff * tank->level) * communicationStepSize;
  if (tank->level < 0.0) tank->level = 0.0; /* 空箱不会抽成负液位 */
  tank->time = currentCommunicationPoint + communicationStepSize;
  return 0;
}

FMI2_Export fmi2Status fmi2Terminate(fmi2Component component) {
  (void)component;
  return 0;
}

FMI2_Export void fmi2FreeInstance(fmi2Component component) { free(component); }
