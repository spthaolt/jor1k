// -------------------------------------------------
// ------------------- SYSTEM ----------------------
// -------------------------------------------------

"use strict";
// common
var message = require('./messagehandler'); // global variable
var utils = require('./utils');
var RAM = require('./ram');
var bzip2 = require('./bzip2');
var elf = require('./elf');
var Timer = require('./timer');
var HTIF = require('./riscv/htif');

// CPU
var OR1KCPU = require('./or1k');
var RISCVCPU = require('./riscv');

// Devices
var UARTDev = require('./dev/uart');
var IRQDev = require('./dev/irq');
var TimerDev = require('./dev/timer');
var FBDev = require('./dev/framebuffer');
var EthDev = require('./dev/ethmac');
var ATADev = require('./dev/ata');
var RTCDev = require('./dev/rtc');
var CLINTDev = require('./dev/clint');
var ROMDev = require('./dev/rom');
var TouchscreenDev = require('./dev/touchscreen');
var KeyboardDev = require('./dev/keyboard');
var SoundDev = require('./dev/sound');
var VirtIODev = require('./dev/virtio');
var Virtio9p = require('./dev/virtio/9p');
var VirtioDummy = require('./dev/virtio/dummy');
var VirtioInput = require('./dev/virtio/input');
var VirtioNET = require('./dev/virtio/net');
var VirtioBlock = require('./dev/virtio/block');
var VirtioGPU = require('./dev/virtio/gpu');
var VirtioConsole = require('./dev/virtio/console');
var FS = require('./filesystem/filesystem');

/* 
    Heap Layout for OpenRISC emulation
    ==================================
    The heap is needed by the asm.js CPU. 
    For compatibility all CPUs use the same layout
    by using the different views of typed arrays

    ------ Core 1 ------
    0x0     -  0x7F     32 CPU registers 
    0x80    -  0x1FFF   CPU specific, usually unused or temporary data
    0x2000  -  0x3FFF   group 0 (system control and status)
    0x4000  -  0x5FFF   group 1 (data MMU)
    0x6000  -  0x7FFF   group 2 (instruction MMU)
    ------ Core 2 ------
    0x8000  -  0x807F   32 CPU registers
    0x8080  -  0x9FFF   CPU specific, usually unused or temporary data
    0xA000  -  0xBFFF   group 0 (system control and status)
    0xC000  -  0xDFFF   group 1 (data MMU)
    0xE000  -  0xFFFF   group 2 (instruction MMU)
    ------ Core 3 ------
    ...
    ------- RAM --------
    0x100000 -  ...     RAM
*/

var SYSTEM_RUN = 0x1;
var SYSTEM_STOP = 0x2;
var SYSTEM_HALT = 0x3; // Idle

function System() {
    // the Init function is called by the master thread.
    message.Register("LoadAndStart", this.LoadImageAndStart.bind(this) );
    message.Register("execute", this.MainLoop.bind(this));
    message.Register("Init", this.Init.bind(this) );
    message.Register("Reset", this.Reset.bind(this) );
    message.Register("ChangeCore", this.ChangeCPU.bind(this) );
    message.Register("PrintOnAbort", this.PrintState.bind(this) );

    message.Register("GetIPS", function(data) {
        message.Send("GetIPS", this.ips);
        this.ips=0;
    }.bind(this));
}

System.prototype.CreateCPU = function(cpuname, arch) {
    try {
        if (arch == "or1k") {
            this.cpu = new OR1KCPU(cpuname, this.ram, this.heap, this.ncores);
        } else
        if (arch == "riscv") {
            this.cpu = new RISCVCPU(cpuname, this.ram, this.htif, this.heap, this.ncores);
        } else
            throw "Architecture " + arch + " not supported";
    } catch (e) {
        message.Debug("Error: failed to create CPU:" + e);
    }
};


System.prototype.ChangeCPU = function(cpuname) {
    this.cpu.switchImplementation(cpuname);
};

System.prototype.Reset = function() {
    this.status = SYSTEM_STOP;
    
    for(var i=0; i<this.devices.length; i++) {
        this.devices[i].Reset();
    }

    this.ips = 0;
};

System.prototype.Init = function(system) {
    this.status = SYSTEM_STOP;
    this.memorysize = system.memorysize;

    this.ncores = system.ncores;
    if (!system.ncores) system.ncores = 1;

    // this must be a power of two.
    message.Debug("Allocate " + this.memorysize + " MB");
    var ramoffset = 0x100000;
    this.heap = new ArrayBuffer(this.memorysize*0x100000); 
    this.memorysize--; // - the lower 1 MB are used for the cpu cores
    this.ram = new RAM(this.heap, ramoffset);

    if (system.arch == "riscv") {
        this.htif = new HTIF(this.ram, this);
    }

    this.CreateCPU(system.cpu, system.arch);

    this.devices = [];
    this.devices.push(this.cpu);

    this.filesystem = new FS();
    this.virtio9pdev = new Virtio9p(this.ram, this.filesystem);

    if (system.arch == "or1k") {

        this.irqdev = new IRQDev(this);
        this.timerdev = new TimerDev();
        this.uartdev0 = new UARTDev(0, this, 0x2);
        this.uartdev1 = new UARTDev(1, this, 0x3);
        this.ethdev = new EthDev(this.ram, this);
        this.ethdev.TransmitCallback = function(data){
            message.Send("ethmac", data);
        };

        this.fbdev = new FBDev(this.ram);
        this.atadev = new ATADev(this);
        this.tsdev = new TouchscreenDev(this);
        this.kbddev = new KeyboardDev(this);
        this.snddev = new SoundDev(this, this.ram);
        this.rtcdev = new RTCDev(this);

        this.virtioinputdev = new VirtioInput(this.ram);
        this.virtionetdev = new VirtioNET(this.ram);
        this.virtioblockdev = new VirtioBlock(this.ram);
        this.virtiodummydev = new VirtioDummy(this.ram);
        this.virtiogpudev = new VirtioGPU(this.ram);
        this.virtioconsoledev = new VirtioConsole(this.ram);
        this.virtiodev1 = new VirtIODev(this, 0x6, this.ram, this.virtio9pdev);
        this.virtiodev2 = new VirtIODev(this, 0xB, this.ram, this.virtiodummydev);
        this.virtiodev3 = new VirtIODev(this, 0xC, this.ram, this.virtiodummydev);

        this.devices.push(this.irqdev);
        this.devices.push(this.timerdev);
        this.devices.push(this.uartdev0);
        this.devices.push(this.uartdev1);
        this.devices.push(this.ethdev);
        this.devices.push(this.fbdev);
        this.devices.push(this.atadev);
        this.devices.push(this.tsdev);
        this.devices.push(this.kbddev);
        this.devices.push(this.snddev);
        this.devices.push(this.rtcdev);
        this.devices.push(this.virtio9pdev);
        this.devices.push(this.virtiodev1);
        this.devices.push(this.virtiodev2);
        this.devices.push(this.virtiodev3);

        this.devices.push(this.virtioinputdev);
        this.devices.push(this.virtionetdev);
        this.devices.push(this.virtioblockdev);
        this.devices.push(this.virtiodummydev);
        this.devices.push(this.virtiogpudev);
        this.devices.push(this.virtioconsoledev);

        this.ram.AddDevice(this.uartdev0,   0x90000000, 0x7);
        this.ram.AddDevice(this.fbdev,      0x91000000, 0x1000);
        this.ram.AddDevice(this.ethdev,     0x92000000, 0x1000);
        this.ram.AddDevice(this.tsdev,      0x93000000, 0x1000);
        this.ram.AddDevice(this.kbddev,     0x94000000, 0x100);
        this.ram.AddDevice(this.uartdev1,   0x96000000, 0x7);
        this.ram.AddDevice(this.virtiodev1, 0x97000000, 0x1000);
        this.ram.AddDevice(this.snddev,     0x98000000, 0x400);
        this.ram.AddDevice(this.rtcdev,     0x99000000, 0x1000);
        this.ram.AddDevice(this.irqdev,     0x9A000000, 0x1000);
        this.ram.AddDevice(this.timerdev,   0x9B000000, 0x1000);
        this.ram.AddDevice(this.virtiodev2, 0x9C000000, 0x1000);
        this.ram.AddDevice(this.virtiodev3, 0x9D000000, 0x1000);
        this.ram.AddDevice(this.atadev,     0x9E000000, 0x1000);
    } else 
    if (system.arch == "riscv") {
        // at the moment the htif interface is part of the CPU initialization.
        // However, it uses uartdev0

        this.rom = new ArrayBuffer(0x2000);
        var buffer32view = new Int32Array(this.rom);
        var buffer8view = new Uint8Array(this.rom);
        // boot process starts at 0x1000
        buffer32view[0x400] = 0x297 + 0x80000000 - 0x1000; // auipc t0, DRAM_BASE=0x80000000
        buffer32view[0x401] = 0x597; // auipc a1, 0 // a1 = 0x1004
	buffer32view[0x402] = 0x58593 + ((8*4-4)<<20); // addi a1, a1, 0 (pointer to dtb)
	buffer32view[0x403] = 0xf1402573; // csrr a0,mhartid
	buffer32view[0x404] = 0x00028067  // jalr zero, t0, 0 (jump straight to DRAM_BASE)
        buffer32view[0x405] = 0x00000000; // trap vector
        buffer32view[0x406] = 0x00000000; // trap vector
        buffer32view[0x407] = 0x00000000; // trap vector
/*
compiled dts file
generated via 
dtc -O dtb riscv.dts > riscv.dtb
od -A n -t x1 -v riscv.dtb | sed 's/ /,0x/g' 

/dts-v1/;

/ {
  #address-cells = <2>;
  #size-cells = <2>;
  compatible = "ucbbar,spike-bare-dev";
  model = "ucbbar,spike-bare";
  cpus {
    #address-cells = <1>;
    #size-cells = <0>;
    timebase-frequency = <10000000>;
    CPU0: cpu@0 {
      device_type = "cpu";
      reg = <0>;
      status = "okay";
      compatible = "riscv";
      riscv,isa = "rv32imafdc";
      mmu-type = "riscv,sv32";
      clock-frequency = <1000000000>;
      CPU0_intc: interrupt-controller {
        #interrupt-cells = <1>;
        interrupt-controller;
        compatible = "riscv,cpu-intc";
      };
    };
  };
  memory@80000000 {
    device_type = "memory";
    reg = <0x0 0x80000000 0x0 0x3F00000>;
  };
  soc {
    #address-cells = <2>;
    #size-cells = <2>;
    compatible = "ucbbar,spike-bare-soc", "simple-bus";
    ranges;
    clint@2000000 {
      compatible = "riscv,clint0";
      interrupts-extended = <&CPU0_intc 3 &CPU0_intc 7 >;
      reg = <0x0 0x2000000 0x0 0xc0000>;
    };
  };
};

*/

var configstring = new Int8Array([
 0xd0,0x0d,0xfe,0xed,0x00,0x00,0x03,0xe0,0x00,0x00,0x00,0x38,0x00,0x00,0x03,0x18
,0x00,0x00,0x00,0x28,0x00,0x00,0x00,0x11,0x00,0x00,0x00,0x10,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0xc8,0x00,0x00,0x02,0xe0,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x02
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x0f,0x00,0x00,0x00,0x02
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x16,0x00,0x00,0x00,0x1b,0x75,0x63,0x62,0x62
,0x61,0x72,0x2c,0x73,0x70,0x69,0x6b,0x65,0x2d,0x62,0x61,0x72,0x65,0x2d,0x64,0x65
,0x76,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x12,0x00,0x00,0x00,0x26
,0x75,0x63,0x62,0x62,0x61,0x72,0x2c,0x73,0x70,0x69,0x6b,0x65,0x2d,0x62,0x61,0x72
,0x65,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x63,0x70,0x75,0x73,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x0f,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x2c,0x00,0x98,0x96,0x80
,0x00,0x00,0x00,0x01,0x63,0x70,0x75,0x40,0x30,0x00,0x00,0x00,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x3f,0x63,0x70,0x75,0x00,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x4b,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x05,0x00,0x00,0x00,0x4f,0x6f,0x6b,0x61,0x79,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x06,0x00,0x00,0x00,0x1b,0x72,0x69,0x73,0x63
,0x76,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x0b,0x00,0x00,0x00,0x56
,0x72,0x76,0x33,0x32,0x69,0x6d,0x61,0x66,0x64,0x63,0x00,0x00,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x0b,0x00,0x00,0x00,0x60,0x72,0x69,0x73,0x63,0x76,0x2c,0x73,0x76
,0x33,0x32,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x69
,0x3b,0x9a,0xca,0x00,0x00,0x00,0x00,0x01,0x69,0x6e,0x74,0x65,0x72,0x72,0x75,0x70
,0x74,0x2d,0x63,0x6f,0x6e,0x74,0x72,0x6f,0x6c,0x6c,0x65,0x72,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x79,0x00,0x00,0x00,0x01
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x8a,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x0f,0x00,0x00,0x00,0x1b,0x72,0x69,0x73,0x63,0x76,0x2c,0x63,0x70
,0x75,0x2d,0x69,0x6e,0x74,0x63,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04
,0x00,0x00,0x00,0x9f,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04
,0x00,0x00,0x00,0xa5,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x02
,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x01,0x6d,0x65,0x6d,0x6f,0x72,0x79,0x40,0x38
,0x30,0x30,0x30,0x30,0x30,0x30,0x30,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x07
,0x00,0x00,0x00,0x3f,0x6d,0x65,0x6d,0x6f,0x72,0x79,0x00,0x00,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x10,0x00,0x00,0x00,0x4b,0x00,0x00,0x00,0x00,0x80,0x00,0x00,0x00
,0x00,0x00,0x00,0x00,0x03,0xf0,0x00,0x00,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x01
,0x73,0x6f,0x63,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x04,0x00,0x00,0x00,0x0f
,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x21,0x00,0x00,0x00,0x1b
,0x75,0x63,0x62,0x62,0x61,0x72,0x2c,0x73,0x70,0x69,0x6b,0x65,0x2d,0x62,0x61,0x72
,0x65,0x2d,0x73,0x6f,0x63,0x00,0x73,0x69,0x6d,0x70,0x6c,0x65,0x2d,0x62,0x75,0x73
,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xad
,0x00,0x00,0x00,0x01,0x63,0x6c,0x69,0x6e,0x74,0x40,0x32,0x30,0x30,0x30,0x30,0x30
,0x30,0x00,0x00,0x00,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x0d,0x00,0x00,0x00,0x1b
,0x72,0x69,0x73,0x63,0x76,0x2c,0x63,0x6c,0x69,0x6e,0x74,0x30,0x00,0x00,0x00,0x00
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x10,0x00,0x00,0x00,0xb4,0x00,0x00,0x00,0x01
,0x00,0x00,0x00,0x03,0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x07,0x00,0x00,0x00,0x03
,0x00,0x00,0x00,0x10,0x00,0x00,0x00,0x4b,0x00,0x00,0x00,0x00,0x02,0x00,0x00,0x00
,0x00,0x00,0x00,0x00,0x00,0x0c,0x00,0x00,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x02
,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x09,0x23,0x61,0x64,0x64,0x72,0x65,0x73,0x73
,0x2d,0x63,0x65,0x6c,0x6c,0x73,0x00,0x23,0x73,0x69,0x7a,0x65,0x2d,0x63,0x65,0x6c
,0x6c,0x73,0x00,0x63,0x6f,0x6d,0x70,0x61,0x74,0x69,0x62,0x6c,0x65,0x00,0x6d,0x6f
,0x64,0x65,0x6c,0x00,0x74,0x69,0x6d,0x65,0x62,0x61,0x73,0x65,0x2d,0x66,0x72,0x65
,0x71,0x75,0x65,0x6e,0x63,0x79,0x00,0x64,0x65,0x76,0x69,0x63,0x65,0x5f,0x74,0x79
,0x70,0x65,0x00,0x72,0x65,0x67,0x00,0x73,0x74,0x61,0x74,0x75,0x73,0x00,0x72,0x69
,0x73,0x63,0x76,0x2c,0x69,0x73,0x61,0x00,0x6d,0x6d,0x75,0x2d,0x74,0x79,0x70,0x65
,0x00,0x63,0x6c,0x6f,0x63,0x6b,0x2d,0x66,0x72,0x65,0x71,0x75,0x65,0x6e,0x63,0x79
,0x00,0x23,0x69,0x6e,0x74,0x65,0x72,0x72,0x75,0x70,0x74,0x2d,0x63,0x65,0x6c,0x6c
,0x73,0x00,0x69,0x6e,0x74,0x65,0x72,0x72,0x75,0x70,0x74,0x2d,0x63,0x6f,0x6e,0x74
,0x72,0x6f,0x6c,0x6c,0x65,0x72,0x00,0x6c,0x69,0x6e,0x75,0x78,0x2c,0x70,0x68,0x61
,0x6e,0x64,0x6c,0x65,0x00,0x72,0x61,0x6e,0x67,0x65,0x73,0x00,0x69,0x6e,0x74,0x65
,0x72,0x72,0x75,0x70,0x74,0x73,0x2d,0x65,0x78,0x74,0x65,0x6e,0x64,0x65,0x64,0x00
]);

	for(var i=0; i<configstring.length; i++) buffer8view[0x1020+i] = configstring[i];

        this.virtiodev1 = new VirtIODev(this, 0x1, this.ram, this.virtio9pdev);
        this.romdev = new ROMDev(this.rom);
        this.uartdev0 = new UARTDev(0, this, 0xD);
        this.clintdev = new CLINTDev(this);

        this.devices.push(this.romdev);
        this.devices.push(this.uartdev0);
        this.devices.push(this.clintdev);
        this.devices.push(this.virtiodev1);
        this.devices.push(this.virtio9pdev);

        this.ram.AddDevice(this.romdev,      0x00000000, 0x7);
        this.ram.AddDevice(this.uartdev0,    0x30000000, 0x2000);
        this.ram.AddDevice(this.clintdev,    0x02000000, 0x2000);
        this.ram.AddDevice(this.virtiodev1,  0x20000000, 0x2000);
    }

    this.ips = 0; // external instruction per second counter
    this.idletime = 0; // start time of the idle routine
    this.idlemaxwait = 0; // maximum waiting time in cycles

    // constants
    this.ticksperms = 20000; // 20 MHz
    this.loopspersecond = 100; // main loops per second, to keep the system responsive

    this.timer = new Timer(this.ticksperms, this.loopspersecond);
};

System.prototype.RaiseInterrupt = function(line) {
    //message.Debug("Raise " + line);
    this.cpu.RaiseInterrupt(line, -1); // raise all cores
    if (this.status == SYSTEM_HALT)
    {
        this.status = SYSTEM_RUN;
        clearTimeout(this.idletimeouthandle);
        var delta = (utils.GetMilliseconds() - this.idletime) * this.ticksperms;
        if (delta > this.idlemaxwait) delta = this.idlemaxwait;
        this.cpu.ProgressTime(delta);
        this.MainLoop();
    }
};

System.prototype.ClearInterrupt = function (line) {
    this.cpu.ClearInterrupt(line, -1); // clear all cores
};

System.prototype.RaiseSoftInterrupt = function(line, cpuid) {
    // the cpu cannot be halted when this function is called, so skip this check
    this.cpu.RaiseInterrupt(line, cpuid);
};

System.prototype.ClearSoftInterrupt = function (line, cpuid) {
    this.cpu.ClearInterrupt(line, cpuid);
};

System.prototype.PrintState = function() {
    // Flush the buffer of the terminal
    this.uartdev0 && this.uartdev0.Step();
    this.uartdev1 && this.uartdev1.Step();
    message.Debug(this.cpu.toString());
};

System.prototype.SendStringToTerminal = function(str)
{
    var chars = [];
    for (var i = 0; i < str.length; i++) {
        chars.push(str.charCodeAt(i));
    }
    message.Send("tty0", chars);
};

System.prototype.LoadImageAndStart = function(url) {
    this.SendStringToTerminal("\r================================================================================");

    if (typeof url == 'string') {
        this.SendStringToTerminal("\r\nLoading kernel and hard and basic file system from web server. Please wait ...\r\n");
        utils.LoadBinaryResource(
            url, 
            this.OnKernelLoaded.bind(this), 
            function(error){throw error;}
        );
    } else {
        this.OnKernelLoaded(url);
    }

};

System.prototype.PatchKernel = function(length)
{
    var m = this.ram.uint8mem;
    // set the correct memory size
    for(var i=0; i<length; i++) { // search for the compiled dts file in the kernel
        if (m[i+0] === 0x6d) // find "memory\0"
        if (m[i+1] === 0x65)
        if (m[i+2] === 0x6d)
        if (m[i+3] === 0x6f)
        if (m[i+4] === 0x72)
        if (m[i+5] === 0x79)
        if (m[i+6] === 0x00) 
        if (m[i+24] === 0x01) 
        if (m[i+25] === 0xF0) 
        if (m[i+26] === 0x00) 
        if (m[i+27] === 0x00) {
            m[i+24] = (this.memorysize*0x100000)>>24;
            m[i+25] = (this.memorysize*0x100000)>>16;
            m[i+26] = 0x00;
            m[i+27] = 0x00;
        }
    }
};

System.prototype.OnKernelLoaded = function(buffer) {
    this.SendStringToTerminal("Decompressing kernel...\r\n");
    var buffer8 = new Uint8Array(buffer);
    var length = buffer.byteLength;

    if (elf.IsELF(buffer8)) {
        elf.Extract(buffer8, this.ram);
    } else 
    if (bzip2.IsBZIP2(buffer8)) {
        length = 0;
        bzip2.simple(buffer8, function(x){this.ram.uint8mem[length++] = x;}.bind(this));
        if (elf.IsELF(this.ram.uint8mem)) {
            var temp = new Uint8Array(length);
            for(var i=0; i<length; i++) {
                temp[i] = this.ram.uint8mem[i];
            }
            elf.Extract(temp, this.ram.uint8mem);
        }
    } else {
        for(var i=0; i<length; i++) this.ram.uint8mem[i] = buffer8[i];
    }

    // OpenRISC CPU uses Big Endian
    if (this.cpu.littleendian == false) {
        this.PatchKernel(length);
        this.ram.Little2Big(length);
    }
    message.Debug("Kernel loaded: " + length + " bytes");
    this.SendStringToTerminal("Booting\r\n");
    this.SendStringToTerminal("================================================================================");
    // we can start the boot process already, even if the filesystem is not yet ready

    this.cpu.Reset();
    this.cpu.AnalyzeImage();
    message.Debug("Starting emulation");
    this.status = SYSTEM_RUN;

    message.Send("execute", 0);
};

// the kernel has sent a halt signal, so stop everything until the next interrupt is raised
System.prototype.HandleHalt = function() {
    var delta = this.cpu.GetTimeToNextInterrupt();
    if (delta == -1) return;
        this.idlemaxwait = delta;
        var mswait = Math.floor(delta / this.ticksperms / this.timer.correction + 0.5);
        //message.Debug("wait " + mswait);
        
        if (mswait <= 1) return;
        if (mswait > 1000) message.Debug("Warning: idle for " + mswait + "ms");
        this.idletime = utils.GetMilliseconds();
        this.status = SYSTEM_HALT;
        this.idletimeouthandle = setTimeout(function() {
            if (this.status == SYSTEM_HALT) {
                this.status = SYSTEM_RUN;
                this.cpu.ProgressTime(delta);
                //this.snddev.Progress();
                this.MainLoop();
            }
        }.bind(this), mswait);
};

System.prototype.MainLoop = function() {
    if (this.status != SYSTEM_RUN) return;
    message.Send("execute", 0);

    // execute the cpu loop for "instructionsperloop" instructions.
    var stepsleft = this.cpu.Step(this.timer.instructionsperloop, this.timer.timercyclesperinstruction);
    //message.Debug(stepsleft);
    var totalsteps = this.timer.instructionsperloop - stepsleft;
    totalsteps++; // at least one instruction
    this.ips += totalsteps;

    this.uartdev0 && this.uartdev0.Step();
    this.uartdev1 && this.uartdev1.Step();
    //this.snddev.Progress();

    // stepsleft != 0 indicates CPU idle
    var gotoidle = stepsleft?true:false;

    this.timer.Update(totalsteps, this.cpu.GetTicks(), gotoidle);

    if (gotoidle) {
        this.HandleHalt(); 
    }

    // go to worker thread idle state that onmessage is executed
};

module.exports = System;
